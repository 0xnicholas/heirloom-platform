/**
 * 动作/函数执行器 —— spec 20 章（锚 80 S4/S5/S7/S9 函数位）。
 *
 * invoke：参数处理（默认填充 + ref 预取注入）→ execute 源文本进程内求值
 * （new Function 包裹，绑定 = 定义 JSON bindings 的类型 token + 结构化异常
 * 类，spec 60 §2.1）→ 活事务写通道 flush → 审计行 → COMMIT。
 *
 * 事务纪律（spec 20 §6）：单请求单事务、全有或全无；任何抛错 → ROLLBACK
 * （回滚 = 无事发生，不落审计）；statement_timeout 上限（默认 30s，可配置）。
 *
 * 错误映射（server 层 M6 消费，spec 30 §6）：
 * - UnknownCallableError → 404；UnknownParamError → 400（请求体畸形域）
 * - ValidationFailed（dsl，冒泡）→ 422；PermissionDenied（dsl）→ 403
 * - PreconditionFailedError / UniqueConflictError / LinkRestrictedError → 409
 */
import { PermissionDenied, ValidationFailed } from "@heirloom/dsl";
import type { CallableDef, OntologyDefinition, PropertyDef, StructDef } from "@heirloom/dsl";
import { compileFilterFragment, type FilterNode, type PredicateByType } from "./query.js";
import {
  WriteChannel,
  validatePropValue,
  type EditRecord,
} from "./write.js";

// ────────────────────────────── 错误族 ──────────────────────────────

export class UnknownCallableError extends Error {
  constructor(readonly kind: "action" | "function", readonly apiName: string) {
    super(`${kind === "action" ? "动作" : "函数"}不存在：${apiName}`);
    this.name = "UnknownCallableError";
  }
}

/** 未知参数名（spec 30 §2 请求体畸形域 → 400，与 422 严格分立） */
export class UnknownParamError extends Error {
  constructor(readonly apiName: string, readonly param: string) {
    super(`未知参数：${param}（${apiName} 参数集外）`);
    this.name = "UnknownParamError";
  }
}

// ────────────────────────────── 身份上下文 ──────────────────────────────

/** 调用主体（M6 PAT 认证装配；M5 白名单在此层前置） */
export interface InvokeActor {
  subjectId: string | null;
  subjectKind: "user" | "service" | null;
  tokenId: string | null;
  /** ctx.userId / ctx.groups 的值（用户/服务账号名或组名表） */
  userId: string;
  groups: readonly string[];
}

export interface InvokeOptions {
  /** 动作事务超时上限（spec 20 §6：必须存在上限；默认 30s） */
  timeoutMs?: number;
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ────────────────────────────── 参数处理 ──────────────────────────────

/** 求值动态默认源文本（(ctx) => value 形态） */
function evalDynamicDefault(source: string, ctx: { userId: string; groups: readonly string[]; today: string; now: string }): unknown {
  const fn = new Function("ctx", `"use strict"; return (${source})(ctx);`);
  return fn(ctx);
}

/** struct 参数/属性值递归形状校验（严格：未知字段拒绝） */
function validateStructValue(def: OntologyDefinition, structApi: string, value: unknown, field: string): void {
  const structDef: StructDef | undefined = def.structs.find((s) => s.apiName === structApi);
  if (!structDef) throw new ValidationFailed({ [field]: `struct 不存在：${structApi}` });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationFailed({ [field]: "必须为对象" });
  }
  const obj = value as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!structDef.properties.some((p) => p.apiName === k)) {
      throw new ValidationFailed({ [field]: `未知字段：${k}（struct ${structApi}）` });
    }
  }
  for (const prop of structDef.properties) {
    const v = obj[prop.apiName];
    if (v === undefined) {
      if (prop.required) throw new ValidationFailed({ [field]: `必填字段缺失：${prop.apiName}` });
      continue;
    }
    if (prop.type === "struct" && prop.struct && v !== null) {
      validateStructValue(def, prop.struct, v, `${field}.${prop.apiName}`);
      continue;
    }
    validatePropValue(prop, v, `${field}.${prop.apiName}`);
  }
}

/**
 * 参数装配：未知参数名 → 400；缺失/类型/形状 → ValidationFailed(422)；
 * 静态默认填充、动态默认求值（spec 20 §3）；ref 参数预取注入完整对象
 * （不存在 = 参数校验范畴，spec 30 §3.3）。
 * 返回 { params(注入后 execute 实参), auditable(审计入参视图——ref 保持 UUID) }。
 */
function prepareParams(
  def: OntologyDefinition,
  callable: CallableDef,
  raw: Record<string, unknown>,
  identity: { userId: string; groups: readonly string[]; today: string; now: string },
  channel: WriteChannel,
): { params: Record<string, unknown>; auditable: Record<string, unknown> } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationFailed({ _: "请求体必须为参数对象" });
  }
  const params: Record<string, unknown> = {};
  const auditable: Record<string, unknown> = {};

  for (const [name, param] of Object.entries(callable.params)) {
    let value: unknown = raw[name];
    if (value === undefined) {
      if (param.default?.kind === "static") value = param.default.value;
      else if (param.default?.kind === "dynamic") value = evalDynamicDefault(param.default.source, identity);
      else if (param.required) {
        throw new ValidationFailed({ [name]: `必填参数缺失（${callable.apiName}.${name}）` });
      }
    }
    auditable[name] = value;
    if (value === undefined || value === null) {
      if (param.required) {
        throw new ValidationFailed({ [name]: `必填参数不得为 null（${callable.apiName}.${name}）` });
      }
      params[name] = null;
      continue;
    }

    if (param.type === "ref") {
      // ref：UUID 串 → 预取注入完整对象（spec 20 §3）
      if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        throw new ValidationFailed({ [name]: `ref 参数必须为 UUID（得到 ${JSON.stringify(value)}）` });
      }
      const obj = channel.get(param.target!, value);
      if (!obj) {
        throw new ValidationFailed({ [name]: `对象不存在：${param.target} ${value}` });
      }
      params[name] = obj;
      continue;
    }

    if (param.type === "struct" && param.struct) {
      validateStructValue(def, param.struct, value, name);
      params[name] = value;
      continue;
    }

    params[name] = validatePropValue(param as PropertyDef, value, name);
  }

  for (const k of Object.keys(raw)) {
    if (!(k in callable.params)) throw new UnknownParamError(callable.apiName, k);
  }
  return { params, auditable };
}

// ────────────────────────────── execute 求值 ──────────────────────────────

/** execute 源文本 → (ctx, params) => result（绑定注入 bindings + 异常类） */
export function buildExecute(source: string, def: OntologyDefinition): (ctx: unknown, params: unknown) => unknown {
  // vitest SSR 变换噪音清洗（生产路径 CLI esbuild 求值无此噪音；dsl 侧
  // free-identifiers 同源处理）——__vite_ssr_import_N__.X → X
  const cleaned = source.replace(/__vite_ssr_import_\d+__\./g, "");
  const bindNames = Object.keys(def.bindings);
  const bindValues = bindNames.map((name) => {
    const b = def.bindings[name]!;
    // 类型 token：运行时只需 apiName（ctx.create(Type, …) 的类型引用）
    return { apiName: b.apiName, __hlKind: b.kind };
  });
  const names = [...bindNames, "ValidationFailed", "PermissionDenied"];
  const values = [...bindValues, ValidationFailed, PermissionDenied];
  const factory = new Function(...names, `"use strict"; return (${cleaned});`);
  const fn = factory(...values) as (ctx: unknown, params: unknown) => unknown;
  if (typeof fn !== "function") {
    throw new Error(`execute 源文本不是函数：${cleaned.slice(0, 50)}`);
  }
  return fn;
}

/** 活事务对象上的类型标记已由写通道挂载（非枚举 __type）*/

// ────────────────────────────── ctx 组装 ──────────────────────────────

interface CtxIdentity {
  readonly userId: string;
  readonly groups: readonly string[];
  readonly today: string;
  readonly now: string;
}

/** 动作 ctx：写五件套 + 读（全量可见——行级谓词只管读面，spec 20 §7 / 50 §8） */
function makeActionCtx(channel: WriteChannel, identity: CtxIdentity): Record<string, unknown> {
  const objOf = (o: { id: string }): { id: string } => o;
  return {
    ...identity,
    create: (type: unknown, props: Record<string, unknown>) => channel.create(type, props),
    modify: (type: unknown, obj: { id: string }, patch: Record<string, unknown>, opts?: { expectedUpdatedAt?: string }) =>
      channel.modify(type, obj, patch, opts),
    delete: (obj: { id: string; __type?: string }) => channel.delete(obj),
    link: (type: unknown, obj: { id: string }, linkName: string, target: { id: string }) =>
      channel.link(type, objOf(obj), linkName, objOf(target)),
    unlink: (type: unknown, obj: { id: string }, linkName: string, target: { id: string }) =>
      channel.unlink(type, objOf(obj), linkName, objOf(target)),
    all: (type: unknown) => channel.all(type),
    get: (type: unknown, id: string) => channel.get(type, id),
    linked: (type: unknown, obj: { id: string }, linkName: string) => channel.linked(type, objOf(obj), linkName),
    backlinks: (type: unknown, obj: { id: string }, reverseName: string) => channel.backlinks(type, objOf(obj), reverseName),
  };
}

/** 只读 q（spec 20 §11）：读授权照常生效（谓词在预载 SELECT 注入） */
function makeQueryCtx(channel: WriteChannel): Record<string, unknown> {
  const objOf = (o: { id: string }): { id: string } => o;
  return {
    all: (type: unknown) => channel.all(type),
    get: (type: unknown, id: string) => channel.get(type, id),
    linked: (type: unknown, obj: { id: string }, linkName: string) => channel.linked(type, objOf(obj), linkName),
    backlinks: (type: unknown, obj: { id: string }, reverseName: string) => channel.backlinks(type, objOf(obj), reverseName),
  };
}

// ────────────────────────────── 事务编排 ──────────────────────────────

interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}
interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

async function inTransaction<T>(
  pool: PgPoolLike,
  timeoutMs: number,
  body: (client: PgClientLike, exec: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const exec = (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> =>
    client.query(sql, params).then((r) => r.rows);
  try {
    await client.query("BEGIN");
    // SET 不支持绑定参数（utility command）——timeoutMs 为引擎内部数字，直拼无注入面
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    const out = await body(client, exec);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ────────────────────────────── 公共入口 ──────────────────────────────

export interface InvokeActionResult {
  /** execute 返回值原样（JSON 化由 server 层） */
  result: unknown;
  /** 编辑集（审计同款；server 层可直接复用） */
  edits: EditRecord[];
}

/** 动作调用：单事务、审计一行（已提交才落，spec 20 §10） */
export async function invokeAction(
  pool: PgPoolLike,
  def: OntologyDefinition,
  apiName: string,
  rawParams: Record<string, unknown>,
  actor: InvokeActor,
  opts: InvokeOptions = {},
): Promise<InvokeActionResult> {
  const actionDef = def.actions.find((a) => a.apiName === apiName);
  if (!actionDef) throw new UnknownCallableError("action", apiName);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  const identity: CtxIdentity = {
    userId: actor.userId,
    groups: actor.groups,
    today: localToday(),
    now: new Date().toISOString(),
  };

  return inTransaction(pool, timeoutMs, async (client, exec) => {
    const channel = await WriteChannel.load(def, exec);
    const { params, auditable } = prepareParams(def, actionDef, rawParams, identity, channel);
    const fn = buildExecute(actionDef.executeSource, def);
    const ctx = makeActionCtx(channel, identity);

    let result: unknown;
    try {
      result = fn(ctx, params);
    } catch (e) {
      if (e instanceof ValidationFailed || e instanceof PermissionDenied) throw e; // 422/403（安全日志由 server 层记）
      throw e;
    }
    // pending/指令落地（约束违例 → ValidationFailed/Unique/Precondition/LinkRestricted）
    const edits = await channel.flush();

    // 审计行（已提交动作一行，spec 20 §10；回滚路径不落 = 本函数抛错即未到此处）
    const txid = (await exec(`SELECT txid_current()::text AS txid`, []))[0]?.txid as string | undefined;
    await exec(
      `INSERT INTO hl_audit_log
         (kind, subject_id, subject_kind, token_id, action_api_name, params, edits, expected_updated_at_used, transaction_id, duration_ms)
       VALUES ('action', $1::uuid, $2, $3::uuid, $4, $5::jsonb, $6::jsonb, $7, $8, $9)`,
      [
        actor.subjectId,
        actor.subjectKind,
        actor.tokenId,
        apiName,
        JSON.stringify(auditable),
        JSON.stringify(edits),
        channel.optimisticUsed,
        txid ?? null,
        Date.now() - startedAt,
      ],
    );
    return { result, edits };
  });
}

/** 只读函数调用：无写无审计；读授权谓词注入预载（spec 20 §11 / 50 §7） */
export async function invokeFunction(
  pool: PgPoolLike,
  def: OntologyDefinition,
  apiName: string,
  rawParams: Record<string, unknown>,
  actor: InvokeActor,
  opts: InvokeOptions & { predicateByType?: PredicateByType } = {},
): Promise<unknown> {
  const fnDef = def.functions.find((f) => f.apiName === apiName);
  if (!fnDef) throw new UnknownCallableError("function", apiName);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const identity: CtxIdentity = {
    userId: actor.userId,
    groups: actor.groups,
    today: localToday(),
    now: new Date().toISOString(),
  };

  // 谓词编译（M3 出口复用：谓词词汇 = 查询包算子，spec 40 §9；别名 b 与预载 SELECT 一致）
  const compiledPredicates: Record<string, { sql: string; params: unknown[] }> = {};
  for (const [type, predicate] of Object.entries(opts.predicateByType ?? {})) {
    const frag = compileFilterFragment(type, def, predicate as FilterNode);
    if (frag.sql) compiledPredicates[type] = { sql: frag.sql, params: frag.params };
  }

  return inTransaction(pool, timeoutMs, async (_client, exec) => {
    const channel = await WriteChannel.load(def, exec, { predicateByType: compiledPredicates });
    const { params } = prepareParams(def, fnDef, rawParams, identity, channel);
    const fn = buildExecute(fnDef.executeSource, def);
    return fn(makeQueryCtx(channel), params);
  });
}
