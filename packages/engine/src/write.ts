/**
 * 写通道 —— 活事务编辑五件套（spec 20 §5–§6 / 40 §4 / 40 §8）。
 *
 * 执行模型（由 DSL 类型层决定：ctx 操作全同步）：
 * 1. **预载快照**：事务开始时全类型 SELECT *（含 M:N 链接表）载入内存
 *    ——execute 内代码全量可见（spec 20 §7）；函数路径各类型注入行级谓词；
 * 2. **内存编辑**：五件套同步操作内存（RYW 天然成立）——本事务新建行
 *    （pending，UUIDv7 预生成）与已存在行编辑指令分账；
 * 3. **flush 落地**：已存在行指令顺序执行（顺序写后写胜出——单事务顺序
 *    SQL + Postgres 约束即真相，spec 20 §6）；pending 按链接依赖序 INSERT
 *    （链接值并入 INSERT 列——required FK「先建后链」的根基，spec 40 §5）。
 *
 * 约束承载：标量细约束交 Postgres（23502/23514 → ValidationFailed、
 * 23505 → UniqueConflict）；数组元素级约束（CHECK 不可表达）应用层校验
 * （实现自由度 3）；one-to-many 声明方 required（「每部门必有员工」）
 * flush 前内存检查（实现自由度 6）；required 链接阻删引用方清单内存预检
 * （DB ON DELETE RESTRICT 兜底竞态）。
 */
import { ValidationFailed } from "@heirloom/dsl";
import type { ObjectTypeDef, OntologyDefinition, PropertyDef } from "@heirloom/dsl";
import { columnName, linkTable, objectTable, quoteIdent, tableName } from "./naming.js";
import { decodeRow, type SqlExec } from "./query.js";
import { uuidv7 } from "uuidv7";

// ────────────────────────────── 错误族 ──────────────────────────────

/** 乐观锁命中旧值（spec 20 §8 / 40 §8）→ HTTP 409 PRECONDITION_FAILED */
export class PreconditionFailedError extends Error {
  constructor(readonly type: string, readonly id: string, readonly expected: string) {
    super(`并发冲突：${type} ${id} 已被修改（expectedUpdatedAt 命中旧值）`);
    this.name = "PreconditionFailedError";
  }
}

/** unique 冲突 → HTTP 409 UNIQUE_CONFLICT（带约束标识，spec 30 §6） */
export class UniqueConflictError extends Error {
  constructor(readonly constraint: string, readonly message: string) {
    super(message);
    this.name = "UniqueConflictError";
  }
}

/** required 链接阻删 → HTTP 409 LINK_RESTRICTED（带引用方清单，spec 40 §4） */
export class LinkRestrictedError extends Error {
  constructor(readonly referencers: { type: string; id: string; linkName: string }[]) {
    super(`存在 required 链接引用，不可删（${referencers.map((r) => `${r.type}.${r.linkName}`).join(", ")}）`);
    this.name = "LinkRestrictedError";
  }
}

/** PG 约束违例 → ValidationFailed（逐字段，HTTP 422，spec 30 §6）；unique 约束名反查属性名 */
export function constraintToValidationFailed(e: unknown, def?: OntologyDefinition): ValidationFailed {
  const err = e as { code?: string; constraint?: string; column?: string; detail?: string; message?: string };
  const fields: Record<string, string> = {};
  const constraint = err.constraint ?? "";
  if (err.code === "23505") {
    // uq_<table>_<col> 列名含下划线——按本体 unique 属性精确反查（贪婪正则不可靠）
    let propName = "_";
    if (def) {
      for (const t of def.objectTypes) {
        for (const p of t.properties) {
          if (p.unique && constraint === `uq_${tableName(t.apiName)}_${columnName(p.apiName)}`) propName = p.apiName;
        }
      }
    }
    fields[propName] = `唯一性冲突（${constraint}）`;
  } else if (err.code === "23502" && err.column) {
    fields[err.column] = "必填属性缺失";
  } else if (err.code === "23514") {
    const m = /^chk_(\w+)_(\w+)/.exec(constraint);
    fields[m?.[2] ?? "_"] = `约束校验失败（${constraint}）`;
  } else if (err.code === "23503") {
    fields._ = `外键违例（${constraint || err.detail || ""}）`;
  } else {
    fields._ = err.detail ?? err.message ?? "数据校验失败";
  }
  return new ValidationFailed(fields);
}

// ────────────────────────────── 校验助手 ──────────────────────────────

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function fieldFail(field: string, message: string): never {
  throw new ValidationFailed({ [field]: message });
}

/** 标量/形状校验（值编码口径；细标量约束由 DB CHECK/UNIQUE 兜底） */
export function validatePropValue(prop: PropertyDef, value: unknown, field: string): unknown {
  const fail = (msg: string): never => fieldFail(field, msg);
  if (value === null) {
    if (prop.required) fail("必填属性不得为 null");
    return null;
  }
  if (value === undefined) return undefined;
  if (prop.array) {
    if (!Array.isArray(value)) throw new ValidationFailed({ [field]: "数组属性必须传数组" });
    const arr = value as unknown[];
    const el = prop.array.element;
    for (const v of arr) {
      if (v === null) continue;
      if (el.type === "string" || el.type === "enum") {
        if (typeof v !== "string") fail(`数组元素必须为字符串（${field}）`);
        else if (el.values && !el.values.includes(v)) fail(`数组元素超出枚举值集（${field}）`);
      } else if (el.type === "integer") {
        if (typeof v !== "number" || !Number.isInteger(v)) fail(`数组元素必须为整数（${field}）`);
      } else if (el.type === "float") {
        if (typeof v !== "number" || !Number.isFinite(v)) fail(`数组元素必须为数值（${field}）`);
      } else if (el.type === "decimal") {
        if (typeof v !== "string" || !DECIMAL_RE.test(v)) fail(`数组元素必须为 decimal 字符串（${field}）`);
      } else if (el.type === "boolean") {
        if (typeof v !== "boolean") fail(`数组元素必须为布尔（${field}）`);
      }
    }
    if (prop.array.unique) {
      const seen = new Set(arr.map((v) => (v === null || typeof v !== "object" ? String(v) : JSON.stringify(v))));
      if (seen.size !== arr.length) fail(`数组元素 unique（集合语义）：存在重复（${field}）`);
    }
    if (prop.array.length) {
      const { min, max } = prop.array.length;
      if (min !== undefined && arr.length < min) fail(`数组长度不得小于 ${min}（${field}）`);
      if (max !== undefined && arr.length > max) fail(`数组长度不得超过 ${max}（${field}）`);
    }
    return arr;
  }
  switch (prop.type) {
    case "string": case "enum": {
      if (typeof value !== "string") fail("必须为字符串");
      const s = value as string;
      if (prop.type === "enum" && prop.values && !prop.values.includes(s)) fail(`枚举成员外取值（合法集：${prop.values.join(" | ")}）`);
      return s;
    }
    case "boolean":
      if (typeof value !== "boolean") fail("必须为布尔");
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) fail("必须为 ±2^53 内整数");
      return value;
    case "float":
      if (typeof value !== "number" || !Number.isFinite(value)) fail("必须为有限数值");
      return value;
    case "decimal":
      if (typeof value !== "string" || !DECIMAL_RE.test(value)) fail("decimal 必须为数字字符串（spec 10 §3）");
      return value;
    case "date":
      if (typeof value !== "string" || !ISO_DATE.test(value)) fail("date 必须为 YYYY-MM-DD");
      return value;
    case "datetime":
      if (typeof value !== "string" || !ISO_DATETIME.test(value) || Number.isNaN(Date.parse(value))) fail("datetime 必须为 ISO 8601 带时区偏移");
      return value;
    case "struct": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) fail("必须为对象");
      return value;
    }
    default:
      return value;
  }
}

/** API props → 物理列值（camel→snake；struct/json JSON 序列化） */
function encodeRow(typeDef: ObjectTypeDef, props: Record<string, unknown>): { cols: string[]; values: unknown[] } {
  const cols: string[] = [];
  const values: unknown[] = [];
  for (const prop of typeDef.properties) {
    if (!(prop.apiName in props)) continue;
    const v = props[prop.apiName];
    if (v === undefined) continue;
    cols.push(quoteIdent(columnName(prop.apiName)));
    values.push(prop.type === "struct" || prop.type === "json" ? JSON.stringify(v) : v);
  }
  return { cols, values };
}

// ────────────────────────────── 链接解析 ──────────────────────────────

/** 链接遍历名 → 物理落位（写/读同源规则，spec 40 §3；正向声明优先） */
export type LinkPhysical =
  | { mode: "fk-self"; col: string; target: string } // 链接列在本方行 → 单值
  | { mode: "fk-other"; other: string; col: string } // 链接列在对方行（one-to-many / 反向）
  | { mode: "mn"; declarer: string; linkName: string; target: string }; // M:N 链接表 → 多值

export interface ResolvedLink {
  linkApiName: string;
  declarer: string;
  /** 正向遍历（声明方视角） */
  forward: boolean;
  /** 遍历到达的类型 */
  to: string;
  multiple: boolean;
  physical: LinkPhysical;
}

export function resolveLink(def: OntologyDefinition, typeApi: string, name: string): ResolvedLink {
  const typeDef = def.objectTypes.find((t) => t.apiName === typeApi);
  if (!typeDef) throw new ValidationFailed({ _: `未知对象类型：${typeApi}` });
  const forward = (typeDef.links ?? []).find((l) => l.apiName === name);
  if (forward) {
    switch (forward.cardinality) {
      case "many-to-one":
      case "one-to-one":
        return { linkApiName: forward.apiName, declarer: typeApi, forward: true, to: forward.target, multiple: false, physical: { mode: "fk-self", col: `${columnName(forward.apiName)}_id`, target: forward.target } };
      case "one-to-many":
        return { linkApiName: forward.apiName, declarer: typeApi, forward: true, to: forward.target, multiple: true, physical: { mode: "fk-other", other: forward.target, col: `${columnName(forward.reverse)}_id` } };
      case "many-to-many":
        return { linkApiName: forward.apiName, declarer: typeApi, forward: true, to: forward.target, multiple: true, physical: { mode: "mn", declarer: typeApi, linkName: forward.apiName, target: forward.target } };
    }
  }
  for (const declarer of def.objectTypes) {
    for (const l of declarer.links ?? []) {
      if (l.target === typeApi && l.reverse === name) {
        switch (l.cardinality) {
          case "many-to-one":
            return { linkApiName: l.apiName, declarer: declarer.apiName, forward: false, to: declarer.apiName, multiple: true, physical: { mode: "fk-other", other: declarer.apiName, col: `${columnName(l.apiName)}_id` } };
          case "one-to-one":
            return { linkApiName: l.apiName, declarer: declarer.apiName, forward: false, to: declarer.apiName, multiple: false, physical: { mode: "fk-other", other: declarer.apiName, col: `${columnName(l.apiName)}_id` } };
          case "one-to-many":
            return { linkApiName: l.apiName, declarer: declarer.apiName, forward: false, to: declarer.apiName, multiple: false, physical: { mode: "fk-self", col: `${columnName(l.reverse)}_id`, target: declarer.apiName } };
          case "many-to-many":
            return { linkApiName: l.apiName, declarer: declarer.apiName, forward: false, to: declarer.apiName, multiple: true, physical: { mode: "mn", declarer: declarer.apiName, linkName: l.apiName, target: l.target } };
        }
      }
    }
  }
  throw new ValidationFailed({ [name]: `未知链接：${typeApi}.${name}` });
}

// ────────────────────────────── 编辑记录 ──────────────────────────────

export interface EditRecord {
  type: string;
  id: string;
  op: "create" | "modify" | "delete" | "link" | "unlink";
  /** link/unlink：`${declarer}.${linkName}` */
  link?: string;
}

/** 已存在行的编辑指令（flush 顺序执行——顺序写后写胜出，spec 20 §6） */
type Instr =
  | { op: "modify"; type: string; id: string; patch: Record<string, unknown>; expectedUpdatedAt?: string }
  | { op: "delete"; type: string; id: string }
  | { op: "link"; type: string; id: string; col: string; targetId: string; table: string }
  | { op: "unlink"; type: string; id: string; col: string; table: string }
  | { op: "mn-add"; declarer: string; linkName: string; fromId: string; toId: string }
  | { op: "mn-remove"; declarer: string; linkName: string; fromId: string; toId: string };

interface PendingCreate {
  type: string;
  typeDef: ObjectTypeDef;
  props: Record<string, unknown>;
  links: Map<string, string | null>; // 物理列 → 目标 id
}

// ────────────────────────────── 写通道 ──────────────────────────────

/**
 * 活事务写通道：预载快照（构造异步工厂 {@link WriteChannel.load}）+
 * 同步内存编辑 + {@link WriteChannel.flush} 落地。
 */
export class WriteChannel {
  private readonly store = new Map<string, Map<string, Record<string, unknown>>>(); // type → id → 物理行
  private readonly linkRows = new Map<string, { from: string; to: string }[]>(); // 链接表全限定名 → 行
  private readonly pending = new Map<string, PendingCreate>();
  private readonly deletedIds = new Set<string>();
  private readonly instrs: Instr[] = [];
  /** flush 后可查：本事务是否用过乐观锁（审计字段，spec 20 §10） */
  optimisticUsed = false;
  readonly edits: EditRecord[] = [];

  private constructor(
    readonly def: OntologyDefinition,
    private readonly exec: SqlExec,
  ) {}

  /** 预载快照（事务内一致性视图）；predicateByType 注入各类型行级谓词（函数路径） */
  static async load(
    def: OntologyDefinition,
    exec: SqlExec,
    opts: { predicateByType?: Record<string, { sql: string; params: unknown[] }> } = {},
  ): Promise<WriteChannel> {
    const ch = new WriteChannel(def, exec);
    for (const t of def.objectTypes) {
      const pred = opts.predicateByType?.[t.apiName];
      // 谓词片段以别名 b 引用列（与 compileFilterFragment 默认一致）
      const rows = pred
        ? await exec(`SELECT b.* FROM ${objectTable(t.apiName)} b WHERE ${pred.sql}`, pred.params)
        : await exec(`SELECT * FROM ${objectTable(t.apiName)}`, []);
      ch.store.set(t.apiName, new Map(rows.map((r) => [r.id as string, r])));
    }
    for (const declarer of def.objectTypes) {
      for (const l of declarer.links ?? []) {
        if (l.cardinality !== "many-to-many") continue;
        const lt = linkTable(declarer.apiName, l.apiName);
        const rows = await exec(`SELECT * FROM ${lt}`, []);
        ch.linkRows.set(lt, rows.map((r) => ({ from: r.from_id as string, to: r.to_id as string })));
      }
    }
    return ch;
  }

  private typeDef(apiName: string): ObjectTypeDef {
    const t = this.def.objectTypes.find((x) => x.apiName === apiName);
    if (!t) throw new ValidationFailed({ _: `未知对象类型：${apiName}` });
    return t;
  }

  // ── 读（内存快照 + pending 合并 + 已删剔除；同步 = RYW）──

  /** 类型 token → apiName（绑定表标识符或 {apiName} 形态） */
  private apiOf(token: unknown): string {
    if (typeof token === "string") return token;
    const t = token as { apiName?: string } | undefined;
    if (!t || typeof t !== "object" || typeof t.apiName !== "string") {
      throw new ValidationFailed({ _: `类型标记非法（须为本体导出的对象类型）` });
    }
    return t.apiName;
  }

  /** 物理行 → API 行（含非枚举 __type 标记：ctx.delete 定位类型用，不入序列化） */
  private toApi(typeDef: ObjectTypeDef, id: string, raw: Record<string, unknown>): Record<string, unknown> {
    const row = decodeRow(typeDef, raw);
    row.id = id;
    Object.defineProperty(row, "__type", { value: typeDef.apiName, enumerable: false, writable: false, configurable: true });
    return row;
  }

  rawOf(id: string): { type: string; raw: Record<string, unknown> } | null {
    for (const [type, rows] of this.store) {
      if (rows.has(id) && !this.deletedIds.has(id)) return { type, raw: rows.get(id)! };
    }
    return null;
  }

  all(typeToken: unknown): Record<string, unknown>[] {
    const typeApi = this.apiOf(typeToken);
    const typeDef = this.typeDef(typeApi);
    const out: Record<string, unknown>[] = [];
    for (const [id, raw] of this.store.get(typeApi) ?? []) {
      if (!this.deletedIds.has(id)) out.push(this.toApi(typeDef, id, raw));
    }
    for (const [id, p] of this.pending) {
      if (p.type === typeApi) out.push(this.toApi(typeDef, id, this.pendingRaw(p)));
    }
    return out;
  }

  get(typeToken: unknown, id: string): Record<string, unknown> | undefined {
    const typeApi = this.apiOf(typeToken);
    const typeDef = this.typeDef(typeApi);
    const p = this.pending.get(id);
    if (p && p.type === typeApi) return this.toApi(typeDef, id, this.pendingRaw(p));
    const raw = this.store.get(typeApi)?.get(id);
    if (!raw || this.deletedIds.has(id)) return undefined;
    return this.toApi(typeDef, id, raw);
  }

  /** 正向遍历（链接名带类型；返回数组，全基数统一，spec 10 §6） */
  linked(typeToken: unknown, obj: { id: string }, linkName: string): Record<string, unknown>[] {
    const typeApi = this.apiOf(typeToken);
    const r = resolveLink(this.def, typeApi, linkName);
    const targetDef = this.typeDef(r.to);
    const toApiRow = (id: string | null | undefined): Record<string, unknown> | null => {
      if (!id) return null;
      const p = this.pending.get(id);
      if (p && p.type === r.to) return this.toApi(targetDef, id, this.pendingRaw(p));
      const raw = this.store.get(r.to)?.get(id);
      if (!raw || this.deletedIds.has(id)) return null;
      return this.toApi(targetDef, id, raw);
    };
    switch (r.physical.mode) {
      case "fk-self": {
        // 本方行持列 → 单值
        const p = this.pending.get(obj.id);
        const colVal = p ? p.links.get(r.physical.col) ?? null : this.rawOf(obj.id)?.raw[r.physical.col];
        const row = toApiRow(colVal as string | null);
        return row ? [row] : [];
      }
      case "fk-other": {
        // 对方行持列 → 多值
        const out: Record<string, unknown>[] = [];
        for (const [id, raw] of this.store.get(r.physical.other) ?? []) {
          if (this.deletedIds.has(id) || raw[r.physical.col] !== obj.id) continue;
          out.push(this.toApi(this.typeDef(r.physical.other), id, raw));
        }
        for (const [id, p] of this.pending) {
          if (p.type === r.physical.other && p.links.get(r.physical.col) === obj.id) {
            out.push(this.toApi(this.typeDef(r.physical.other), id, this.pendingRaw(p)));
          }
        }
        return out;
      }
      case "mn": {
        const lt = linkTable(r.physical.declarer, r.physical.linkName);
        const rows = this.linkRows.get(lt) ?? [];
        const out: Record<string, unknown>[] = [];
        for (const { from, to } of rows) {
          const hit = r.forward ? from === obj.id : to === obj.id;
          if (!hit) continue;
          const targetId = r.forward ? to : from;
          const row = toApiRow(targetId);
          if (row) out.push(row);
        }
        return out;
      }
    }
  }

  /** 反向遍历：按反向名（弱类型，spec 10 §4） */
  backlinks(typeToken: unknown, obj: { id: string }, reverseName: string): Record<string, unknown>[] {
    return this.linked(typeToken, obj, reverseName);
  }

  private pendingRaw(p: PendingCreate): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const prop of p.typeDef.properties) {
      if (prop.apiName in p.props && p.props[prop.apiName] !== undefined) {
        out[columnName(prop.apiName)] = p.props[prop.apiName];
      }
    }
    for (const [col, v] of p.links) out[col] = v;
    return out;
  }

  // ── 五件套（同步内存编辑）──

  /** 建对象：UUIDv7 预生成（spec 40 §5），返回含 id 的完整对象 */
  create(typeToken: unknown, props: Record<string, unknown>): Record<string, unknown> {
    const typeApi = this.apiOf(typeToken);
    const typeDef = this.typeDef(typeApi);
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined) continue;
      const prop = typeDef.properties.find((p) => p.apiName === k);
      if (!prop) fieldFail(k, `未知属性：${typeApi}.${k}`);
      clean[k] = validatePropValue(prop!, v, k);
    }
    for (const prop of typeDef.properties) {
      if (prop.required && !(prop.apiName in clean)) {
        fieldFail(prop.apiName, `必填属性缺失（${typeApi}.${prop.apiName}）`);
      }
    }
    const id = uuidv7();
    this.pending.set(id, { type: typeApi, typeDef, props: clean, links: new Map() });
    this.edits.push({ type: typeApi, id, op: "create" });
    return { id, ...clean };
  }

  /** 部分更新；opts.expectedUpdatedAt 乐观锁（命中旧值 → 整事务回滚） */
  modify(
    typeToken: unknown,
    obj: { id: string },
    patch: Record<string, unknown>,
    opts: { expectedUpdatedAt?: string } = {},
  ): Record<string, unknown> {
    const typeApi = this.apiOf(typeToken);
    const typeDef = this.typeDef(typeApi);
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      const prop = typeDef.properties.find((p) => p.apiName === k);
      if (!prop) fieldFail(k, `未知属性：${typeApi}.${k}`);
      clean[k] = validatePropValue(prop!, v, k);
    }
    const p = this.pending.get(obj.id);
    if (p && p.type === typeApi) {
      Object.assign(p.props, clean);
      this.edits.push({ type: typeApi, id: obj.id, op: "modify" });
      return { id: obj.id, ...p.props };
    }
    const raw = this.store.get(typeApi)?.get(obj.id);
    if (!raw || this.deletedIds.has(obj.id)) {
      fieldFail("id", `对象不存在：${typeApi} ${obj.id}`);
    }
    this.instrs.push({ op: "modify", type: typeApi, id: obj.id, patch: clean, expectedUpdatedAt: opts.expectedUpdatedAt });
    this.edits.push({ type: typeApi, id: obj.id, op: "modify" });
    return this.toApi(typeDef, obj.id, { ...raw!, ...encodeIntoRaw(typeDef, clean) });
  }

  /** 删除：required 链接阻删（引用方清单）/ optional 自动摘链（spec 40 §4） */
  delete(obj: { id: string; __type?: string }): void {
    const id = obj.id;
    if (this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      this.edits.push({ type: p.type, id, op: "delete" });
      return;
    }
    const found = this.rawOf(id);
    if (!found) fieldFail("id", `对象不存在：${id}`);
    const typeApi = obj.__type ?? found!.type;
    // required 链接引用方预检（内存快照；DB RESTRICT 兜底并发竞态）
    const referencers: { type: string; id: string; linkName: string }[] = [];
    for (const declarer of this.def.objectTypes) {
      for (const l of declarer.links ?? []) {
        if ((l.cardinality === "many-to-one" || l.cardinality === "one-to-one") && l.required) {
          const col = `${columnName(l.apiName)}_id`;
          for (const [rid, raw] of this.store.get(declarer.apiName) ?? []) {
            if (!this.deletedIds.has(rid) && raw[col] === id) {
              // 排除同事务将删除的引用行（顺序写后写胜出）
              const willDelete = this.instrs.some((i) => i.op === "delete" && i.id === rid) || this.pendingWillDelete(rid);
              if (!willDelete) referencers.push({ type: declarer.apiName, id: rid, linkName: l.apiName });
            }
          }
        }
      }
    }
    if (referencers.length > 0) throw new LinkRestrictedError(referencers);

    this.deletedIds.add(id);
    this.instrs.push({ op: "delete", type: typeApi, id });
    this.edits.push({ type: typeApi, id, op: "delete" });
  }

  private pendingWillDelete(id: string): boolean {
    return this.deletedIds.has(id);
  }

  /** 建链接：全基数统一；1:N / 1:1 link 即移动（旧侧自动摘除） */
  link(typeToken: unknown, obj: { id: string }, linkName: string, target: { id: string }): void {
    const typeApi = this.apiOf(typeToken);
    const r = resolveLink(this.def, typeApi, linkName);
    // 编辑集主体 = 被物理写入的行（spec 20 §10 逐对象；M:N 记声明方行）
    const editedSubject = (): { type: string; id: string } =>
      r.physical.mode === "fk-other" ? { type: r.physical.other, id: target.id } : { type: typeApi, id: obj.id };
    this.edits.push({ ...editedSubject(), op: "link", link: `${r.declarer}.${r.linkApiName}` });

    if (r.physical.mode === "mn") {
      const lt = linkTable(r.physical.declarer, r.physical.linkName);
      const fromId = r.forward ? obj.id : target.id;
      const toId = r.forward ? target.id : obj.id;
      const rows = this.linkRows.get(lt) ?? [];
      if (!rows.some((x) => x.from === fromId && x.to === toId)) rows.push({ from: fromId, to: toId });
      this.linkRows.set(lt, rows);
      this.instrs.push({ op: "mn-add", declarer: r.physical.declarer, linkName: r.physical.linkName, fromId, toId });
      return;
    }

    if (r.physical.mode === "fk-self") {
      // 链接列在本方行：1:1/many-to-one 正向、one-to-many 反向
      const p = this.pending.get(obj.id);
      if (p && p.type === typeApi) {
        p.links.set(r.physical.col, target.id);
        return;
      }
      this.instrs.push({ op: "link", type: typeApi, id: obj.id, col: r.physical.col, targetId: target.id, table: typeApi });
      return;
    }

    if (r.physical.mode === "fk-other") {
      // fk-other：链接列在对方行（one-to-many 正向 = link 即移动；对方 pending 时并入其创建）
      const p = this.pending.get(target.id);
      if (p && p.type === r.physical.other) {
        p.links.set(r.physical.col, obj.id);
        return;
      }
      this.instrs.push({ op: "link", type: typeApi, id: target.id, col: r.physical.col, targetId: obj.id, table: r.physical.other });
    }
  }

  /** 摘链接：FK 置 NULL / 链接表删行 */
  unlink(typeToken: unknown, obj: { id: string }, linkName: string, target: { id: string }): void {
    const typeApi = this.apiOf(typeToken);
    const r = resolveLink(this.def, typeApi, linkName);
    const editedSubject = (): { type: string; id: string } =>
      r.physical.mode === "fk-other" ? { type: r.physical.other, id: target.id } : { type: typeApi, id: obj.id };
    this.edits.push({ ...editedSubject(), op: "unlink", link: `${r.declarer}.${r.linkApiName}` });

    if (r.physical.mode === "mn") {
      const lt = linkTable(r.physical.declarer, r.physical.linkName);
      const fromId = r.forward ? obj.id : target.id;
      const toId = r.forward ? target.id : obj.id;
      this.linkRows.set(lt, (this.linkRows.get(lt) ?? []).filter((x) => !(x.from === fromId && x.to === toId)));
      this.instrs.push({ op: "mn-remove", declarer: r.physical.declarer, linkName: r.physical.linkName, fromId, toId });
      return;
    }

    if (r.physical.mode === "fk-self") {
      const p = this.pending.get(obj.id);
      if (p && p.type === typeApi) {
        p.links.set(r.physical.col, null);
        return;
      }
      this.instrs.push({ op: "unlink", type: typeApi, id: obj.id, col: r.physical.col, table: typeApi });
      return;
    }

    const p = this.pending.get(target.id);
    if (p && p.type === r.physical.other) {
      p.links.set(r.physical.col, null);
      return;
    }
    this.instrs.push({ op: "unlink", type: typeApi, id: target.id, col: r.physical.col, table: r.physical.other });
  }

  // ── flush：指令顺序执行 + pending 依赖序 INSERT ──

  /** 提交前落地全部编辑；返回编辑集（审计用）。任何违例抛错 → 调用方回滚。 */
  async flush(): Promise<EditRecord[]> {
    // 相位 1：pending create 先行（递归依赖序，spec 40 §5）——后续指令可能
    // 引用 pending 行（M:N 链接行 FK / fk-other UPDATE 指向新建对象）
    const inserting = new Set<string>();
    const insertOne = async (id: string): Promise<void> => {
      const p = this.pending.get(id);
      if (!p) return;
      if (inserting.has(id)) {
        throw new ValidationFailed({ _: `循环链接依赖：${[...inserting, id].join(" → ")}（required 互指不可同时先建）` });
      }
      inserting.add(id);
      for (const targetId of p.links.values()) {
        if (targetId && this.pending.has(targetId)) await insertOne(targetId);
      }
      const { cols, values } = encodeRow(p.typeDef, p.props);
      const allCols = [quoteIdent("id"), ...cols, ...[...p.links.keys()].map((c) => quoteIdent(c))];
      const params: unknown[] = [id, ...values, ...[...p.links.values()]];
      const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
      try {
        await this.exec(`INSERT INTO ${objectTable(p.type)} (${allCols.join(", ")}) VALUES (${placeholders})`, params);
      } catch (e) {
        throw constraintToValidationFailed(e, this.def);
      }
      inserting.delete(id);
    };
    for (const id of [...this.pending.keys()]) await insertOne(id);

    // 相位 2：已存在行编辑指令顺序执行（顺序写后写胜出，spec 20 §6）
    for (const instr of this.instrs) {
      try {
        switch (instr.op) {
          case "modify": {
            const typeDef = this.typeDef(instr.type);
            const { cols, values } = encodeRow(typeDef, instr.patch);
            const params: unknown[] = [];
            const sets = cols.map((c) => { params.push(values[params.length]); return `${c} = $${params.length}`; });
            sets.push(`${quoteIdent("updated_at")} = now()`); // 水位线锚（spec 40 §2）
            params.push(instr.id);
            let where = `${quoteIdent("id")} = $${params.length}::uuid`;
            if (instr.expectedUpdatedAt !== undefined && instr.expectedUpdatedAt !== null) {
              params.push(instr.expectedUpdatedAt);
              where += ` AND ${quoteIdent("updated_at")} = $${params.length}::timestamptz`;
            }
            const rows = await this.exec(
              `UPDATE ${objectTable(instr.type)} SET ${sets.join(", ")} WHERE ${where} RETURNING id`,
              params,
            );
            if (rows.length === 0) {
              if (instr.expectedUpdatedAt != null) throw new PreconditionFailedError(instr.type, instr.id, String(instr.expectedUpdatedAt));
              throw new ValidationFailed({ id: `对象不存在：${instr.type} ${instr.id}` });
            }
            break;
          }
          case "delete":
            await this.exec(`DELETE FROM ${objectTable(instr.type)} WHERE ${quoteIdent("id")} = $1::uuid`, [instr.id]);
            break;
          case "link":
            await this.exec(
              `UPDATE ${objectTable(instr.table)} SET ${quoteIdent(instr.col)} = $1::uuid, ${quoteIdent("updated_at")} = now() WHERE ${quoteIdent("id")} = $2::uuid`,
              [instr.targetId, instr.id],
            );
            break;
          case "unlink":
            await this.exec(
              `UPDATE ${objectTable(instr.table)} SET ${quoteIdent(instr.col)} = NULL, ${quoteIdent("updated_at")} = now() WHERE ${quoteIdent("id")} = $1::uuid`,
              [instr.id],
            );
            break;
          case "mn-add":
            await this.exec(
              `INSERT INTO ${linkTable(instr.declarer, instr.linkName)} (${quoteIdent("from_id")}, ${quoteIdent("to_id")}) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`,
              [instr.fromId, instr.toId],
            );
            break;
          case "mn-remove":
            await this.exec(
              `DELETE FROM ${linkTable(instr.declarer, instr.linkName)} WHERE ${quoteIdent("from_id")} = $1::uuid AND ${quoteIdent("to_id")} = $2::uuid`,
              [instr.fromId, instr.toId],
            );
            break;
        }
      } catch (e) {
        if (e instanceof ValidationFailed || e instanceof PreconditionFailedError) throw e;
        throw constraintToValidationFailed(e, this.def);
      }
    }

    this.optimisticUsed = this.instrs.some((i) => i.op === "modify" && i.expectedUpdatedAt != null);

    // 相位 3：one-to-many 声明方 required（实现自由度 6）：内存快照 + 编辑终态检查
    this.checkOneToManyRequired();

    return this.edits;
  }

  private checkOneToManyRequired(): void {
    for (const declarer of this.def.objectTypes) {
      for (const l of declarer.links ?? []) {
        if (l.cardinality !== "one-to-many" || !l.required) continue;
        const col = `${columnName(l.reverse)}_id`;
        // 声明方存活行（存量非删 + 本事务新建）：每行须有 ≥1 存活 N 侧引用
        const declarerRows = [...(this.store.get(declarer.apiName) ?? new Map()).keys()].filter(
          (id) => !this.deletedIds.has(id) && !this.pending.has(id as string),
        ) as string[];
        const pendingDeclarerIds = [...this.pending.entries()].filter(([, p]) => p.type === declarer.apiName).map(([id]) => id);
        const targetCount = new Map<string, number>();
        for (const [id, raw] of this.store.get(l.target) ?? new Map()) {
          if (this.deletedIds.has(id) || this.pending.has(id)) continue;
          const key = raw[col] as string | null;
          if (key) targetCount.set(key, (targetCount.get(key) ?? 0) + 1);
        }
        for (const [, p] of this.pending) {
          if (p.type !== l.target) continue;
          for (const v of p.links.values()) {
            if (v) targetCount.set(v, (targetCount.get(v) ?? 0) + 1);
          }
        }
        for (const rowId of [...declarerRows, ...pendingDeclarerIds]) {
          if ((targetCount.get(rowId) ?? 0) === 0) {
            throw new ValidationFailed({
              _: `${declarer.apiName}.${l.apiName} 为 required 链接：对象 ${rowId} 缺少关联 ${l.target}`,
            });
          }
        }
      }
    }
  }
}

/** props（camel）→ 物理行 patch（snake；struct/json 保持原值——内存视图用途） */
function encodeIntoRaw(typeDef: ObjectTypeDef, props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of typeDef.properties) {
    if (prop.apiName in props && props[prop.apiName] !== undefined) {
      out[columnName(prop.apiName)] = props[prop.apiName];
    }
  }
  return out;
}
