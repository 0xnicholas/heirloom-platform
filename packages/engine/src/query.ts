/**
 * 查询包编译器 + 执行器 —— spec 30 §3.1（查询体编码）/ 40 §6（算子语义）。
 *
 * 职责：把查询请求（filter/sort/cursor/include/count/limit）编译为纯 SQL 文本 +
 * 参数数组（$n 占位），供 Fastify 语义面与引擎内核共用；附薄执行器组装
 * `{data, nextCursor?, count?}` 信封（spec 30 §2）。
 *
 * 关键语义（normative）：
 * - 过滤算子封闭集：eq/neq/in/gt/gte/lt/lte/contains/startsWith/contains-any
 *   + null 检查（eq:null）；and/or/not 任意嵌套；字段键 = 当前类型属性 +
 *   一跳链接属性点路径（EXISTS 下推，行级谓词随之注入）；大小写敏感
 *   （PG LIKE 语义，反斜杠转义 %_\）。
 * - 排序 ≤3 键、仅当前类型标量属性（链接属性排序 → v2，spec 40 §10）；
 *   id 隐式末位锥；null 排序锁定 PG 默认 ASC NULLS LAST / DESC NULLS FIRST
 *   ——两种方向下 NULL 恒为「最大」（spec 40 §6）。
 * - keyset 游标：排序键值 + id 的不透明 base64url JSON；展开式锥比较
 *   （前缀 IS NOT DISTINCT FROM + 方向化比较），混合方向与 NULL 均正确：
 *   ASC 键上 NULL 键值后无更大者（无 head，仅进前缀）；DESC 键上 NULL 键值
 *   后一切非空值皆排其后（head = IS NOT NULL）。
 * - include 每条链最深 2 跳（>2 → 422）；各跳按各自行级谓词过滤
 *   （M5 经 predicateByType 接入；单值不可见变 null、多值变短，spec 50 §7）。
 * - limit 默认 100、上限 1000；count = 同过滤器聚合计数（不受分页影响）。
 * - decimal 全链路 JSON 字符串（$n::numeric 精确比较）；datetime ISO 8601
 *   必须带时区偏移（$n::timestamptz）。
 * - 行级谓词注入点（spec 40 §9）：主查询 / count / 游标一致；include 各跳；
 *   一跳链接过滤的 EXISTS 内——谓词词汇 = 本查询包算子（同源复用，M5 接线）。
 *
 * 实现自由度（非规格变更）：
 * - 系统字段 id/createdAt/updatedAt 可作过滤与排序字段（水位线增量拉取
 *   spec 40 §7 所需；映射 created_at/updated_at 列）。
 * - 游标内嵌排序签名（类型 + 排序键序）；换排序换游标 → 422，防错位分页。
 */
import type { LinkDef, ObjectTypeDef, OntologyDefinition, PropertyDef } from "@heirloom/dsl";
import { stableStringify } from "./changes.js";
import { columnName, linkTable, objectTable, quoteIdent } from "./naming.js";

// ────────────────────────────── 公共类型 ──────────────────────────────

/** 过滤表达式（JSON 形状；组合子 and/or/not + 字段原子，字段键可带一跳点路径） */
export type FilterNode = Record<string, unknown>;

export interface SortSpec {
  field: string;
  dir: "asc" | "desc";
}

export interface QueryRequest {
  filter?: FilterNode;
  sort?: SortSpec[];
  cursor?: string;
  limit?: number;
  include?: string[];
  count?: boolean;
}

/** 行级谓词表：类型 apiName → 谓词表达式（词汇 = 查询包算子，仅本类型属性，spec 50 §6） */
export type PredicateByType = Record<string, FilterNode>;

export interface CompiledStatement {
  sql: string;
  params: unknown[];
}

/** include 单跳编译产物：$1 恒为父行 id 数组（uuid[]），$2.. 为谓词参数 */
export interface CompiledIncludeHop {
  /** 完整 include 路径（如 "employees.mentor"） */
  path: string;
  /** 0 起 */
  hop: number;
  /** 本跳遍历名（结果挂载字段名） */
  field: string;
  parentType: string;
  targetType: string;
  /** 单值（可 null）还是多值 */
  multiple: boolean;
  statement: CompiledStatement;
}

/** 解析后的排序键（含隐式末位 id；col = 物理列名） */
export interface ResolvedSortKey {
  field: string;
  dir: "asc" | "desc";
  col: string;
  /** 逻辑标量类型（参数 cast / 游标值归一用） */
  scalar: string;
}

export interface CompiledQuery {
  type: string;
  /** 主查询：LIMIT = limit+1（执行器取第 limit+1 行判定 nextCursor） */
  main: CompiledStatement;
  count: CompiledStatement | null;
  includes: CompiledIncludeHop[];
  /** 权威排序键（游标编码/解码依据） */
  sortKeys: ResolvedSortKey[];
  limit: number;
}

export interface QueryResult {
  data: Record<string, unknown>[];
  nextCursor?: string;
  count?: number;
}

export interface QueryIssue {
  path: string;
  message: string;
}

export class QueryValidationError extends Error {
  constructor(readonly issues: QueryIssue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join("; "));
    this.name = "QueryValidationError";
  }
}

export class UnknownTypeError extends Error {
  constructor(readonly typeApiName: string) {
    super(`对象类型不存在：${typeApiName}`);
    this.name = "UnknownTypeError";
  }
}

/** 最小 SQL 执行接口：pg Pool / PoolClient / 任何能跑参数化 SQL 的东西（含事务内） */
export type SqlExec = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

export function pgExec(client: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}): SqlExec {
  return (sql, params) => client.query(sql, params).then((r) => r.rows);
}

// ────────────────────────────── 参数编号 ──────────────────────────────

class Params {
  readonly params: unknown[] = [];
  constructor(private next = 1) {}
  add(value: unknown): string {
    this.params.push(value);
    return `$${this.next++}`;
  }
}

// ─────────────────────────── 字段与遍历解析 ───────────────────────────

const SYSTEM_FIELDS: Record<string, { col: string; type: string }> = {
  id: { col: "id", type: "uuid" },
  createdAt: { col: "created_at", type: "datetime" },
  updatedAt: { col: "updated_at", type: "datetime" },
};

/** 终端字段：类型属性 或 系统字段 */
type TerminalField =
  | { kind: "prop"; def: PropertyDef }
  | { kind: "system"; name: string; col: string; type: string };

/** 一跳链接遍历的物理落位（与 ddl.ts linkPhysical 同源规则，spec 40 §3） */
type Traversal =
  | { mode: "fk-own"; col: string } // 本表 FK 列 → 单值
  | { mode: "fk-their"; side: string; col: string } // 对方唯一 FK（1:1 反向）→ 单值
  | { mode: "fk-many"; side: string; col: string } // 对方非唯一 FK → 多值
  | { mode: "mn"; declarer: string; linkName: string; target: string; fromSide: "from" | "to" }; // M:N 链接表 → 多值

interface HopResolution {
  link: LinkDef;
  declarer: string;
  direction: "forward" | "backward";
  /** 遍历到达的类型 apiName */
  target: string;
  multiple: boolean;
  physical: Traversal;
}

function typeMap(def: OntologyDefinition): Map<string, ObjectTypeDef> {
  return new Map(def.objectTypes.map((t) => [t.apiName, t]));
}

/** 链接名解析：正向声明优先；否则按反向名（目标 = 本类型）唯一反查（spec 10 §4） */
function resolveHop(typeDef: ObjectTypeDef, def: OntologyDefinition, name: string, path: string): HopResolution {
  const forward = (typeDef.links ?? []).find((l) => l.apiName === name);
  if (forward) {
    return { ...forwardPhysical(forward, typeDef.apiName), link: forward, declarer: typeDef.apiName, direction: "forward" };
  }
  for (const declarer of def.objectTypes) {
    for (const l of declarer.links ?? []) {
      if (l.target === typeDef.apiName && l.reverse === name) {
        return { ...backwardPhysical(l, declarer.apiName), link: l, declarer: declarer.apiName, direction: "backward" };
      }
    }
  }
  throw new QueryValidationError([
    { path, message: `未知字段或链接：${name}（字段键 = 本类型属性或「链接名.属性」一跳点路径，spec 40 §6）` },
  ]);
}

function forwardPhysical(link: LinkDef, declarer: string): Omit<HopResolution, "link" | "declarer" | "direction"> {
  switch (link.cardinality) {
    case "many-to-one":
    case "one-to-one":
      // 声明方持 FK（1:1 另有 UNIQUE）→ 正向单值
      return { target: link.target, multiple: false, physical: { mode: "fk-own", col: `${columnName(link.apiName)}_id` } };
    case "one-to-many":
      // 目标方持 FK（列名 = 反向名）→ 正向多值
      return { target: link.target, multiple: true, physical: { mode: "fk-many", side: link.target, col: `${columnName(link.reverse)}_id` } };
    case "many-to-many":
      return { target: link.target, multiple: true, physical: { mode: "mn", declarer, linkName: link.apiName, target: link.target, fromSide: "from" } };
  }
}

function backwardPhysical(link: LinkDef, declarer: string): Omit<HopResolution, "link" | "declarer" | "direction"> {
  switch (link.cardinality) {
    case "many-to-one":
      // 声明方持非唯一 FK 指向本类型 → 反向多值
      return { target: declarer, multiple: true, physical: { mode: "fk-many", side: declarer, col: `${columnName(link.apiName)}_id` } };
    case "one-to-one":
      // 声明方持 UNIQUE FK → 反向单值
      return { target: declarer, multiple: false, physical: { mode: "fk-their", side: declarer, col: `${columnName(link.apiName)}_id` } };
    case "one-to-many":
      // 本类型自身持 FK（反向名列）→ 反向单值
      return { target: declarer, multiple: false, physical: { mode: "fk-own", col: `${columnName(link.reverse)}_id` } };
    case "many-to-many":
      return { target: declarer, multiple: true, physical: { mode: "mn", declarer, linkName: link.apiName, target: link.target, fromSide: "to" } };
  }
}

/** 终端字段解析（属性名或系统字段名） */
function resolveTerminal(typeDef: ObjectTypeDef, name: string): TerminalField | null {
  const sys = SYSTEM_FIELDS[name];
  if (sys) return { kind: "system", name, col: sys.col, type: sys.type };
  const prop = typeDef.properties.find((p) => p.apiName === name);
  return prop ? { kind: "prop", def: prop } : null;
}

// ─────────────────────────── 标量值校验/转型 ───────────────────────────

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 逻辑标量类型名（array/struct/json 不参与标量算子） */
function scalarTypeOf(f: TerminalField): string | null {
  if (f.kind === "system") return f.type;
  const p = f.def;
  if (p.array) return "array";
  if (p.type === "struct" || p.type === "json") return p.type;
  return p.type;
}

function expectString(v: unknown, path: string): string {
  if (typeof v !== "string") throw new QueryValidationError([{ path, message: "值必须为字符串" }]);
  return v;
}

/** 标量值校验与归一（decimal 保字符串、datetime 校 ISO 带偏移、enum 查成员） */
function validateScalar(f: TerminalField, value: unknown, path: string): unknown {
  if (value === null) throw new QueryValidationError([{ path, message: "null 仅用于 eq/neq 的值位" }]);
  if (f.kind === "system") {
    if (f.type === "uuid") {
      const s = expectString(value, path);
      if (!UUID_RE.test(s)) throw new QueryValidationError([{ path, message: "非法 UUID" }]);
      return s;
    }
    return validateIsoDatetime(value, path);
  }
  const p = f.def;
  switch (p.type) {
    case "string":
      return expectString(value, path);
    case "enum": {
      const s = expectString(value, path);
      if (p.values && !p.values.includes(s)) {
        throw new QueryValidationError([{ path, message: `枚举成员外取值 "${s}"（合法集：${p.values.join(" | ")}）` }]);
      }
      return s;
    }
    case "boolean":
      if (typeof value !== "boolean") throw new QueryValidationError([{ path, message: "值必须为布尔" }]);
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        throw new QueryValidationError([{ path, message: "值必须为 ±2^53 内整数" }]);
      }
      return value;
    case "float":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new QueryValidationError([{ path, message: "值必须为有限数值" }]);
      return value;
    case "decimal": {
      const s = expectString(value, path);
      if (!DECIMAL_RE.test(s)) throw new QueryValidationError([{ path, message: "decimal 必须为数字字符串（spec 10 §3）" }]);
      return s;
    }
    case "date": {
      const s = expectString(value, path);
      if (!ISO_DATE.test(s)) throw new QueryValidationError([{ path, message: "date 必须为 YYYY-MM-DD" }]);
      return s;
    }
    case "datetime":
      return validateIsoDatetime(value, path);
    default:
      throw new QueryValidationError([{ path, message: `属性类型 ${p.type} 不支持标量算子` }]);
  }
}

function validateIsoDatetime(value: unknown, path: string): string {
  const s = expectString(value, path);
  if (!ISO_DATETIME.test(s) || Number.isNaN(Date.parse(s))) {
    throw new QueryValidationError([{ path, message: "datetime 必须为 ISO 8601 且带时区偏移（spec 10 §3）" }]);
  }
  return s;
}

/** 参数占位后缀（按列类型显式转型——驱动/游标回灌的字符串都能正确比较） */
function pgCast(scalar: string): string {
  switch (scalar) {
    case "decimal": return "::numeric";
    case "integer": return "::bigint";
    case "float": return "::double precision";
    case "date": return "::date";
    case "datetime": return "::timestamptz";
    case "uuid": return "::uuid";
    default: return "";
  }
}

function arrayCast(scalar: string, path: string, what: string): string {
  const cast = pgCast(scalar);
  if (cast === "::uuid") throw new QueryValidationError([{ path, message: `${what} 不支持该元素类型` }]);
  return cast === "" ? "" : `${cast}[]`;
}

function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, "\\$1");
}

// ──────────────────────────── 过滤编译核心 ────────────────────────────

const COMPARISON_OPS = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
const ALL_OPS = new Set(["eq", "neq", "in", "gt", "gte", "lt", "lte", "contains", "startsWith", "contains-any"]);

interface FilterCtx {
  typeDef: ObjectTypeDef;
  def: OntologyDefinition;
  /** 当前表的别名 */
  alias: string;
  P: Params;
  predicateByType: PredicateByType;
}

/**
 * 单字段原子 → SQL 条件（含一跳链接属性：EXISTS 下推 + 该跳行级谓词注入）。
 */
function compileAtom(key: string, ops: unknown, ctx: FilterCtx): string {
  const { typeDef, def, P } = ctx;
  if (typeof ops !== "object" || ops === null || Array.isArray(ops)) {
    throw new QueryValidationError([{ path: `filter.${key}`, message: "字段条件必须为 {算子: 值} 对象" }]);
  }
  const opEntries = Object.entries(ops as Record<string, unknown>);
  if (opEntries.length === 0) return "TRUE";
  for (const [op] of opEntries) {
    if (!ALL_OPS.has(op)) throw new QueryValidationError([{ path: `filter.${key}`, message: `未知算子 "${op}"（封闭集见 spec 40 §6）` }]);
  }

  const buildCond = (fieldRef: string, field: TerminalField): string => {
    const parts = opEntries.map(([op, rawValue]) => applyOp(fieldRef, field, op, rawValue, `filter.${key}.${op}`, P));
    return parts.length === 1 ? parts[0]! : `(${parts.join(" AND ")})`;
  };

  const segments = key.split(".");
  if (segments.length > 2) {
    throw new QueryValidationError([{ path: `filter.${key}`, message: "点路径最深一跳（spec 40 §6）" }]);
  }

  if (segments.length === 1) {
    const terminal = resolveTerminal(typeDef, segments[0]!);
    if (!terminal) {
      const isLink = (typeDef.links ?? []).some((l) => l.apiName === segments[0]);
      throw new QueryValidationError([
        { path: `filter.${key}`, message: isLink ? "链接名须以「链接名.属性」点路径过滤" : `未知属性：${segments[0]}` },
      ]);
    }
    return buildCond(`${ctx.alias}.${quoteIdent(terminalCol(terminal))}`, terminal);
  }

  // 一跳链接属性：EXISTS 下推（不复制父行）；目标类型行级谓词随之注入
  const hop = resolveHop(typeDef, def, segments[0]!, `filter.${key}`);
  const targetDef = typeMap(def).get(hop.target);
  if (!targetDef) throw new QueryValidationError([{ path: `filter.${key}`, message: `链接目标类型不存在：${hop.target}` }]);
  const terminal = resolveTerminal(targetDef, segments[1]!);
  if (!terminal) {
    throw new QueryValidationError([{ path: `filter.${key}`, message: `类型 ${hop.target} 无属性 ${segments[1]}` }]);
  }
  const cond = buildCond(`s2.${quoteIdent(terminalCol(terminal))}`, terminal);
  const predFrag = predicateFragment(hop.target, "s2", def, P, ctx.predicateByType); // 文本序在后
  const inner = [cond, predFrag].filter((s) => s !== "").join(" AND ") || "TRUE";
  return `EXISTS (SELECT 1 ${hopFrom(hop)} WHERE ${hopJoin(hop, ctx.alias)} AND ${inner})`;
}

function terminalCol(f: TerminalField): string {
  return f.kind === "system" ? f.col : columnName(f.def.apiName);
}

/** 一跳链接 EXISTS 的 FROM 片段（链接表情形内联 JOIN 目标表） */
function hopFrom(hop: HopResolution): string {
  const p = hop.physical;
  switch (p.mode) {
    case "fk-own":
      return `FROM ${objectTable(hop.target)} s2`;
    case "fk-their":
    case "fk-many":
      return `FROM ${objectTable(p.side)} s2`;
    case "mn":
      return `FROM ${linkTable(p.declarer, p.linkName)} lt JOIN ${objectTable(p.target)} s2 ON s2.${quoteIdent("id")} = lt.${quoteIdent(p.fromSide === "from" ? "to_id" : "from_id")}`;
  }
}

/** 一跳链接与父行的连接条件 */
function hopJoin(hop: HopResolution, parentAlias: string): string {
  const p = hop.physical;
  switch (p.mode) {
    case "fk-own":
      return `s2.${quoteIdent("id")} = ${parentAlias}.${quoteIdent(p.col)}`;
    case "fk-their":
    case "fk-many":
      return `s2.${quoteIdent(p.col)} = ${parentAlias}.${quoteIdent("id")}`;
    case "mn":
      return `lt.${quoteIdent(p.fromSide === "from" ? "from_id" : "to_id")} = ${parentAlias}.${quoteIdent("id")}`;
  }
}

/** 算子 → SQL（fieldRef 已含别名） */
function applyOp(fieldRef: string, field: TerminalField, op: string, rawValue: unknown, at: string, P: Params): string {
  const scalar = scalarTypeOf(field);
  const nonScalar = scalar !== null && ["array", "struct", "json"].includes(scalar);

  if (op === "eq" || op === "neq") {
    if (rawValue === null) {
      return op === "eq" ? `${fieldRef} IS NULL` : `${fieldRef} IS NOT NULL`; // eq:null 即 null 检查（spec 30 §3.1）
    }
    if (nonScalar) {
      throw new QueryValidationError([{ path: at, message: `${scalar} 属性仅支持 null 检查` }]);
    }
    const v = validateScalar(field, rawValue, at);
    const ph = P.add(v);
    return op === "eq"
      ? `${fieldRef} = ${ph}${pgCast(scalar!)}`
      : `${fieldRef} IS DISTINCT FROM ${ph}${pgCast(scalar!)}`;
  }

  if (op === "in") {
    if (nonScalar || scalar === null) throw new QueryValidationError([{ path: at, message: "in 仅用于标量属性" }]);
    if (!Array.isArray(rawValue)) throw new QueryValidationError([{ path: at, message: "in 值必须为数组" }]);
    if (rawValue.length === 0) return "FALSE";
    const values = rawValue.map((v) => validateScalar(field, v, at));
    const ph = P.add(values);
    return `${fieldRef} = ANY(${ph}${arrayCast(scalar!, at, "in")})`;
  }

  if (op === "contains-any") {
    if (field.kind !== "prop" || !field.def.array) {
      throw new QueryValidationError([{ path: at, message: "contains-any 仅用于数组属性" }]);
    }
    if (!Array.isArray(rawValue) || rawValue.length === 0) {
      throw new QueryValidationError([{ path: at, message: "contains-any 值必须为非空数组" }]);
    }
    // 元素按数组内层类型校验
    const el = field.def.array.element;
    const elemField: TerminalField = { kind: "prop", def: { ...field.def, array: undefined, type: el.type, values: el.values } };
    const values = rawValue.map((v) => validateScalar(elemField, v, at));
    const ph = P.add(values);
    return `${fieldRef} && ${ph}${arrayCast(el.type, at, "contains-any")}`;
  }

  if (op === "contains" || op === "startsWith") {
    if (scalar !== "string") throw new QueryValidationError([{ path: at, message: `${op} 仅用于 string 属性` }]);
    const v = expectString(rawValue, at);
    const ph = P.add(op === "contains" ? `%${escapeLike(v)}%` : `${escapeLike(v)}%`);
    return `${fieldRef} LIKE ${ph}`; // PG 默认反斜杠转义
  }

  if (op in COMPARISON_OPS) {
    if (scalar === null || scalar === "boolean" || nonScalar) {
      throw new QueryValidationError([{ path: at, message: `${op} 不支持 ${scalar ?? "该"}类型` }]);
    }
    const v = validateScalar(field, rawValue, at);
    const ph = P.add(v);
    return `${fieldRef} ${COMPARISON_OPS[op as keyof typeof COMPARISON_OPS]} ${ph}${pgCast(scalar!)}`;
  }

  throw new QueryValidationError([{ path: at, message: `未知算子 "${op}"` }]);
}

/** 类型行级谓词片段（spec 40 §9 / 50 §7：同源算子词汇，AND 进 WHERE） */
function predicateFragment(
  typeApiName: string,
  alias: string,
  def: OntologyDefinition,
  P: Params,
  predicateByType: PredicateByType,
): string {
  const expr = predicateByType[typeApiName];
  if (!expr) return "";
  const typeDef = typeMap(def).get(typeApiName);
  if (!typeDef) return "";
  return compileFilter(expr, { typeDef, def, alias, P, predicateByType });
}

/** 过滤表达式 → SQL 条件（'' = 无条件）；and/or/not 任意嵌套、多键隐式 AND */
export function compileFilter(node: FilterNode | undefined, ctx: FilterCtx): string {
  if (node === undefined || node === null) return "";
  if (typeof node !== "object" || Array.isArray(node)) {
    throw new QueryValidationError([{ path: "filter", message: "过滤表达式必须为对象" }]);
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "and" || key === "or") {
      if (!Array.isArray(value)) throw new QueryValidationError([{ path: `filter.${key}`, message: `${key} 值必须为数组` }]);
      const children = value.map((child) => compileFilter(child as FilterNode, ctx)).filter((s) => s !== "");
      parts.push(children.length === 0 ? (key === "and" ? "TRUE" : "FALSE") : `(${children.join(key === "and" ? " AND " : " OR ")})`);
    } else if (key === "not") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new QueryValidationError([{ path: "filter.not", message: "not 值必须为对象" }]);
      }
      const child = compileFilter(value as FilterNode, ctx);
      parts.push(child === "" ? "TRUE" : `NOT (${child})`);
    } else {
      parts.push(compileAtom(key, value, ctx));
    }
  }
  return parts.length === 0 ? "" : parts.length === 1 ? parts[0]! : `(${parts.join(" AND ")})`;
}

/** 独立谓词编译入口（M5 读授权复用：谓词 JSON → WHERE 片段；ctx 常量注入 M5 扩展） */
export function compileFilterFragment(
  typeApiName: string,
  def: OntologyDefinition,
  filter: FilterNode,
  opts: { alias?: string } = {},
): CompiledStatement {
  const typeDef = typeMap(def).get(typeApiName);
  if (!typeDef) throw new UnknownTypeError(typeApiName);
  const P = new Params();
  const sql = compileFilter(filter, { typeDef, def, alias: opts.alias ?? "b", P, predicateByType: {} });
  return { sql, params: P.params };
}

// ──────────────────────────── 排序与 keyset ────────────────────────────

const SORTABLE = new Set(["string", "boolean", "integer", "float", "decimal", "date", "datetime", "enum", "uuid"]);

function resolveSortKeys(typeApiName: string, def: OntologyDefinition, sort: SortSpec[] | undefined): ResolvedSortKey[] {
  const typeDef = typeMap(def).get(typeApiName);
  if (!typeDef) throw new UnknownTypeError(typeApiName);
  const specs = sort ?? [];
  if (specs.length > 3) {
    throw new QueryValidationError([{ path: "sort", message: "排序键不得超过 3 个（spec 30 §3.1）" }]);
  }
  const seen = new Set<string>();
  const keys: ResolvedSortKey[] = [];
  for (const s of specs) {
    if (!s || typeof s.field !== "string") throw new QueryValidationError([{ path: "sort", message: "排序项必须含 field" }]);
    if (s.dir !== "asc" && s.dir !== "desc") {
      throw new QueryValidationError([{ path: `sort.${s.field}`, message: `dir 必须为 asc/desc（得到 "${s.dir}"）` }]);
    }
    if (s.field.includes(".")) {
      throw new QueryValidationError([{ path: `sort.${s.field}`, message: "按链接属性排序 → v2（spec 40 §10）" }]);
    }
    if (seen.has(s.field)) throw new QueryValidationError([{ path: `sort.${s.field}`, message: "排序键重复" }]);
    seen.add(s.field);
    const terminal = resolveTerminal(typeDef, s.field);
    if (!terminal) {
      throw new QueryValidationError([{ path: `sort.${s.field}`, message: `排序字段必须是 ${typeApiName} 的标量属性（或 id/createdAt/updatedAt）` }]);
    }
    const scalar = scalarTypeOf(terminal);
    if (!scalar || !SORTABLE.has(scalar)) {
      throw new QueryValidationError([{ path: `sort.${s.field}`, message: `属性类型 ${scalar} 不可排序` }]);
    }
    keys.push({ field: s.field, dir: s.dir, col: terminalCol(terminal), scalar });
  }
  // id 隐式末位锥（稳定排序）；用户末位显式 id 则不重复
  const lastIsId = keys.length > 0 && keys[keys.length - 1]!.col === "id";
  if (!lastIsId) keys.push({ field: "id", dir: "asc", col: "id", scalar: "uuid" });
  return keys;
}

function cursorSignature(typeApiName: string, sortKeys: ResolvedSortKey[]): string {
  return stableStringify({ type: typeApiName, sort: sortKeys.map((k) => [k.col, k.dir]) });
}

/** 游标值归一（date → 本地 YYYY-MM-DD；datetime → ISO；其余原样）——兼容驱动返回形状 */
function normalizeCursorValue(scalar: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return scalar === "date" ? localDateStr(v) : v.toISOString();
  return v;
}

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function encodeCursor(typeApiName: string, sortKeys: ResolvedSortKey[], row: Record<string, unknown>): string {
  const values = sortKeys.slice(0, -1).map((k) => normalizeCursorValue(k.scalar, row[k.col] ?? null));
  const payload = JSON.stringify({ s: cursorSignature(typeApiName, sortKeys), k: values, id: row.id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

function decodeCursor(typeApiName: string, sortKeys: ResolvedSortKey[], cursor: string): { values: unknown[]; id: string } {
  let parsed: { s?: string; k?: unknown[]; id?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new QueryValidationError([{ path: "cursor", message: "游标不可解析（客户端不得解析或自行构造，spec 30 §3.1）" }]);
  }
  if (parsed.s !== cursorSignature(typeApiName, sortKeys)) {
    throw new QueryValidationError([{ path: "cursor", message: "游标与当前类型/排序不匹配（换排序须从首页重查）" }]);
  }
  if (!Array.isArray(parsed.k) || parsed.k.length !== sortKeys.length - 1 || typeof parsed.id !== "string" || !UUID_RE.test(parsed.id)) {
    throw new QueryValidationError([{ path: "cursor", message: "游标载荷形状非法" }]);
  }
  return { values: parsed.k, id: parsed.id };
}

/**
 * keyset 锥（展开式）：行严格排在游标行之后 ⟺
 *   ∃i: 前缀键全等（IS NOT DISTINCT FROM——NULL 与 NULL 排序相等）
 *   ∧ 第 i 键方向化严格在后。
 * NULL 恒为最大（ASC NULLS LAST / DESC NULLS FIRST，spec 40 §6）：
 *   - ASC 键：非空游标值 → head = (> c OR IS NULL)；NULL 游标值 → 无 head，仅进前缀
 *   - DESC 键：非空游标值 → head = (< c)；NULL 游标值 → head = IS NOT NULL
 * 末位 id 恒非空 → OR 支至少一项。
 */
function keysetPredicate(keys: ResolvedSortKey[], cursor: { values: unknown[]; id: string }, alias: string, P: Params): string {
  const full = [
    ...keys.slice(0, -1).map((k, i) => ({ k, v: cursor.values[i] })),
    { k: keys[keys.length - 1]!, v: cursor.id as unknown },
  ];
  const branches: string[] = [];
  const prefix: string[] = [];
  for (const { k, v } of full) {
    const ref = `${alias}.${quoteIdent(k.col)}`;
    if (v !== null) {
      const ph = P.add(v);
      // id 主键非空，无需 NULL 分支；可空列按 NULL=最大补 IS NULL 支
      const head =
        k.col === "id"
          ? `${ref} > ${ph}${pgCast(k.scalar)}`
          : k.dir === "asc"
            ? `(${ref} > ${ph}${pgCast(k.scalar)} OR ${ref} IS NULL)`
            : `(${ref} < ${ph}${pgCast(k.scalar)})`;
      const branch = [...prefix, head].join(" AND ");
      branches.push(prefix.length > 0 ? `(${branch})` : branch);
      prefix.push(`${ref} IS NOT DISTINCT FROM ${ph}${pgCast(k.scalar)}`);
    } else if (k.dir === "desc") {
      branches.push([...prefix, `${ref} IS NOT NULL`].join(" AND "));
      prefix.push(`${ref} IS NULL`);
    } else {
      prefix.push(`${ref} IS NULL`);
    }
  }
  return branches.length === 1 ? branches[0]! : `(${branches.join(" OR ")})`;
}

// ──────────────────────────── 查询编译总装 ────────────────────────────

export interface CompileQueryOptions {
  /** 行级谓词（M5 接线；主查询/count/游标一致 + include 各跳 + EXISTS 内，spec 40 §9） */
  predicateByType?: PredicateByType;
}

export function compileQuery(
  typeApiName: string,
  def: OntologyDefinition,
  request: QueryRequest,
  opts: CompileQueryOptions = {},
): CompiledQuery {
  const typeDef = typeMap(def).get(typeApiName);
  if (!typeDef) throw new UnknownTypeError(typeApiName);
  const predicateByType = opts.predicateByType ?? {};

  // limit：默认 100、上限 1000（spec 30 §3.1 / 40 §6）
  let limit = 100;
  if (request.limit !== undefined) {
    if (typeof request.limit !== "number" || !Number.isInteger(request.limit) || request.limit < 1) {
      throw new QueryValidationError([{ path: "limit", message: "limit 必须为正整数" }]);
    }
    if (request.limit > 1000) {
      throw new QueryValidationError([{ path: "limit", message: "limit 上限 1000（spec 40 §6）" }]);
    }
    limit = request.limit;
  }

  const sortKeys = resolveSortKeys(typeApiName, def, request.sort);
  const cursor = request.cursor !== undefined ? decodeCursor(typeApiName, sortKeys, request.cursor) : null;

  // WHERE 片段（文本序 = 参数序：filter → 行级谓词 → keyset）
  const P = new Params();
  const filterFrag = compileFilter(request.filter, { typeDef, def, alias: "b", P, predicateByType });
  const predFrag = predicateFragment(typeApiName, "b", def, P, predicateByType);
  const keysetFrag = cursor ? keysetPredicate(sortKeys, cursor, "b", P) : "";
  const whereParts = [filterFrag, predFrag, keysetFrag].filter((s) => s !== "");
  const where = whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";

  const limitPh = P.add(limit + 1); // 多取一行探测 nextCursor
  const orderBy = sortKeys.map((k) => `b.${quoteIdent(k.col)} ${k.dir === "asc" ? "ASC NULLS LAST" : "DESC NULLS FIRST"}`).join(", ");
  const main: CompiledStatement = {
    sql: `SELECT b.* FROM ${objectTable(typeApiName)} b${where} ORDER BY ${orderBy} LIMIT ${limitPh}`,
    params: P.params,
  };

  // count：同过滤器（+谓词）聚合计数，不受分页影响（spec 30 §3.1）
  let count: CompiledStatement | null = null;
  if (request.count === true) {
    const CP = new Params();
    const cf = compileFilter(request.filter, { typeDef, def, alias: "b", P: CP, predicateByType });
    const cp = predicateFragment(typeApiName, "b", def, CP, predicateByType);
    const cWhere = [cf, cp].filter((s) => s !== "").join(" AND ");
    count = {
      sql: `SELECT count(*)::int AS n FROM ${objectTable(typeApiName)} b${cWhere ? ` WHERE ${cWhere}` : ""}`,
      params: CP.params,
    };
  }

  const includes = compileIncludes(typeApiName, def, request.include, predicateByType);

  return { type: typeApiName, main, count, includes, sortKeys, limit };
}

/** include 编译：每条链 ≤2 跳（>2 → 422）；逐跳生成 $1=父 id 数组的取行查询 */
function compileIncludes(
  typeApiName: string,
  def: OntologyDefinition,
  include: string[] | undefined,
  predicateByType: PredicateByType,
): CompiledIncludeHop[] {
  const hops: CompiledIncludeHop[] = [];
  const seen = new Set<string>();
  for (const rawPath of include ?? []) {
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      throw new QueryValidationError([{ path: "include", message: "include 条目必须为非空点路径" }]);
    }
    const segments = rawPath.split(".");
    if (segments.length > 2) {
      throw new QueryValidationError([{ path: `include.${rawPath}`, message: "include 每条链最深 2 跳（spec 30 §3.1）" }]);
    }
    if (seen.has(rawPath)) continue;
    seen.add(rawPath);
    let parentType = typeApiName;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const parentDef = typeMap(def).get(parentType)!;
      const hop = resolveHop(parentDef, def, seg, `include.${rawPath}[${i}]`);
      hops.push({
        path: rawPath,
        hop: i,
        field: seg,
        parentType,
        targetType: hop.target,
        multiple: hop.multiple,
        statement: compileIncludeHopStatement(hop, parentType, def, predicateByType),
      });
      parentType = hop.target;
    }
  }
  return hops;
}

/**
 * 单跳取行查询。谓词落位决定收窄形状（spec 50 §7）：
 * - 单值：LEFT JOIN + 谓词进 ON——子不可见 → 父行仍在、字段为 null
 * - 多值：谓词进 JOIN ON / WHERE——不可见侧剔除、多值变短，父行不因此消失
 */
function compileIncludeHopStatement(
  hop: HopResolution,
  parentType: string,
  def: OntologyDefinition,
  predicateByType: PredicateByType,
): CompiledStatement {
  const P = new Params(2); // $1 保留给父行 id 数组（uuid[]）
  const predFrag = predicateFragment(hop.target, "s", def, P, predicateByType);
  const idCol = quoteIdent("id");
  const child = objectTable(hop.target);
  const p = hop.physical;

  switch (p.mode) {
    case "fk-own": {
      // 父行持 FK → 单值
      const on = [`s.${idCol} = p.${quoteIdent(p.col)}`, predFrag].filter(Boolean).join(" AND ");
      return {
        sql: `SELECT p.${idCol} AS __parent_id, s.* FROM ${objectTable(parentType)} p LEFT JOIN ${child} s ON ${on} WHERE p.${idCol} = ANY($1::uuid[]) ORDER BY p.${idCol}`,
        params: P.params,
      };
    }
    case "fk-their": {
      // 对方持 UNIQUE FK（1:1 反向）→ 单值
      const on = [`s.${quoteIdent(p.col)} = p.${idCol}`, predFrag].filter(Boolean).join(" AND ");
      return {
        sql: `SELECT p.${idCol} AS __parent_id, s.* FROM ${objectTable(parentType)} p LEFT JOIN ${child} s ON ${on} WHERE p.${idCol} = ANY($1::uuid[]) ORDER BY p.${idCol}`,
        params: P.params,
      };
    }
    case "fk-many": {
      // 子行持非唯一 FK → 多值；直接以 FK 列为父锚，无需 JOIN 父表
      const where = [`s.${quoteIdent(p.col)} = ANY($1::uuid[])`, predFrag].filter(Boolean).join(" AND ");
      return {
        sql: `SELECT s.${quoteIdent(p.col)} AS __parent_id, s.* FROM ${child} s WHERE ${where} ORDER BY __parent_id, s.${idCol}`,
        params: P.params,
      };
    }
    case "mn": {
      const mine = p.fromSide === "from" ? "from_id" : "to_id";
      const theirs = p.fromSide === "from" ? "to_id" : "from_id";
      const on = [`s.${idCol} = lt.${quoteIdent(theirs)}`, predFrag].filter(Boolean).join(" AND ");
      return {
        sql: `SELECT lt.${quoteIdent(mine)} AS __parent_id, s.* FROM ${linkTable(p.declarer, p.linkName)} lt JOIN ${child} s ON ${on} WHERE lt.${quoteIdent(mine)} = ANY($1::uuid[]) ORDER BY __parent_id, s.${idCol}`,
        params: P.params,
      };
    }
  }
}

// ───────────────────────────── 行解码 ─────────────────────────────

function decodeValue(prop: PropertyDef | undefined, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (prop?.array) {
    const el = prop.array.element.type;
    if (!Array.isArray(v)) return v;
    return v.map((x) => {
      if (x === null) return null;
      switch (el) {
        case "integer":
        case "float": return Number(x);
        case "decimal": return String(x);
        case "date": return x instanceof Date ? localDateStr(x) : String(x);
        case "datetime": return x instanceof Date ? x.toISOString() : String(x);
        default: return x;
      }
    });
  }
  const t = prop?.type;
  switch (t) {
    case "integer":
    case "float": return Number(v);
    case "decimal": return String(v);
    case "date": return v instanceof Date ? localDateStr(v) : String(v);
    case "datetime": return v instanceof Date ? v.toISOString() : String(v);
    default: return v; // string/enum/boolean/json/struct（jsonb 已被驱动解析）
  }
}

/** 物理行 → API 行（snake → camel + 标量编码，spec 10 §3 / 30 §2） */
export function decodeRow(typeDef: ObjectTypeDef, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: raw.id,
    createdAt: raw.created_at instanceof Date ? (raw.created_at as Date).toISOString() : raw.created_at,
    updatedAt: raw.updated_at instanceof Date ? (raw.updated_at as Date).toISOString() : raw.updated_at,
  };
  for (const prop of typeDef.properties) {
    out[prop.apiName] = decodeValue(prop, raw[columnName(prop.apiName)]);
  }
  return out;
}

// ───────────────────────────── 执行器 ─────────────────────────────

/**
 * 薄执行器：跑编译产物并组装 `{data, nextCursor?, count?}` 信封；include
 * 逐跳批量取行（每跳一条 SQL，父 id 批量锚定——无 N+1）后挂载。
 */
export async function executeQuery(
  exec: SqlExec,
  typeApiName: string,
  def: OntologyDefinition,
  request: QueryRequest,
  opts: CompileQueryOptions = {},
): Promise<QueryResult> {
  const compiled = compileQuery(typeApiName, def, request, opts);
  const typeDef = typeMap(def).get(typeApiName)!;
  const limit = compiled.limit;

  const rawRows = await exec(compiled.main.sql, compiled.main.params);
  const hasMore = rawRows.length > limit;
  const pageRaw = hasMore ? rawRows.slice(0, limit) : rawRows;

  const result: QueryResult = {
    data: pageRaw.map((r) => decodeRow(typeDef, r)),
    ...(hasMore ? { nextCursor: encodeCursor(typeApiName, compiled.sortKeys, pageRaw[pageRaw.length - 1]!) } : {}),
  };

  if (compiled.count) {
    const rows = await exec(compiled.count.sql, compiled.count.params);
    result.count = Number(rows[0]?.n ?? 0);
  }

  if (compiled.includes.length > 0 && result.data.length > 0) {
    // 路径分组逐跳执行：hop1 父集 = 页行；hop2 父集 = hop1 挂载的子对象
    const byPath = new Map<string, CompiledIncludeHop[]>();
    for (const h of compiled.includes) byPath.set(h.path, [...(byPath.get(h.path) ?? []), h]);
    for (const hops of byPath.values()) {
      let parents = result.data.map((obj) => ({ id: obj.id as string, obj }));
      for (const hop of hops) {
        if (parents.length === 0) break;
        const parentIds = [...new Set(parents.map((p) => p.id))];
        const rows = await exec(hop.statement.sql, [parentIds, ...hop.statement.params]);
        const childDef = typeMap(def).get(hop.targetType)!;
        const groups = new Map<string, Record<string, unknown>[]>();
        for (const r of rows) {
          const parentId = String(r.__parent_id);
          if (r.id === null || r.id === undefined) {
            // LEFT JOIN 无子行占位：父存在但单值为 null
            if (!groups.has(parentId)) groups.set(parentId, []);
            continue;
          }
          const list = groups.get(parentId) ?? [];
          list.push(decodeRow(childDef, r));
          groups.set(parentId, list);
        }
        const next: { id: string; obj: Record<string, unknown> }[] = [];
        for (const p of parents) {
          const children = groups.get(p.id) ?? [];
          p.obj[hop.field] = hop.multiple ? children : children.length > 0 ? children[0]! : null;
          for (const c of children) next.push({ id: c.id as string, obj: c });
        }
        parents = next;
      }
    }
  }

  return result;
}
