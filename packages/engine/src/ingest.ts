/**
 * 批量接入 —— 引擎写入通道的管理面暴露（spec 70 §2 / 30 §4.2，锚 80 S2）。
 *
 * 单请求单事务、≤1000 操作、任一条违约束 → 整批回滚 + 违规条目清单
 * （index 定位——依赖 write.ts WriteOpError 的 editIndex 归因）；**不触发
 * 动作语义**（无 execute/ValidationFailed 动作审计——审计以导入批次形态）。
 *
 * 审计纪律（spec 70 §4）：每请求**恰好一条** kind='import-batch' 条目——
 * 成功：同事务落（计数真实）；失败：回滚后单独补落（计数全 0——
 * 「试过灌」本身可见）。requestId 与响应回执一致。
 *
 * 错误族（server 层映射）：
 * - IngestBadRequestError → 400（操作条目结构畸形）
 * - BatchTooLargeError → 413（>1000）
 * - IngestConflictError → 409（unique / required 链接阻删）
 * - IngestValidationFailedError → 422（NOT NULL/CHECK/FK/缺对象/类型校验）
 */
import { randomBytes } from "node:crypto";
import { ValidationFailed } from "@heirloom/dsl";
import type { OntologyDefinition } from "@heirloom/dsl";
import { WriteChannel, WriteOpError, LinkRestrictedError } from "./write.js";

export interface IngestCreateOp {
  type: string;
  op: "create";
  object: Record<string, unknown>;
}
export interface IngestModifyOp {
  type: string;
  op: "modify";
  id: string;
  patch: Record<string, unknown>;
}
export interface IngestDeleteOp {
  type: string;
  op: "delete";
  id: string;
}
export type IngestOperation = IngestCreateOp | IngestModifyOp | IngestDeleteOp;

export interface IngestActor {
  subjectId: string | null;
  subjectKind: "user" | "service" | null;
  tokenId: string | null;
}

export interface IngestViolation {
  index: number;
  type: string;
  op: "create" | "modify" | "delete";
  /** unique 冲突约束标识（employee.employeeNo 形态） */
  constraint?: string;
  /** 校验失败字段（能定位时） */
  field?: string;
  message: string;
}

export class IngestBadRequestError extends Error {
  constructor(readonly issues: { index: number; message: string }[]) {
    super(`接入操作畸形：${issues.map((i) => `#${i.index}: ${i.message}`).join("; ")}`);
    this.name = "IngestBadRequestError";
  }
}

export class BatchTooLargeError extends Error {
  constructor(readonly count: number) {
    super(`批量超上限：${count} > 1000（spec 40 §8）`);
    this.name = "BatchTooLargeError";
  }
}

export class IngestConflictError extends Error {
  constructor(
    readonly code: "UNIQUE_CONFLICT" | "LINK_RESTRICTED",
    readonly violations: IngestViolation[] | { type: string; id: string; linkName: string }[],
  ) {
    super(code);
    this.name = "IngestConflictError";
  }
}

export class IngestValidationFailedError extends Error {
  constructor(readonly violations: IngestViolation[]) {
    super(`接入校验失败：${violations.length} 条违规`);
    this.name = "IngestValidationFailedError";
  }
}

export interface IngestResult {
  requestId: string;
  counts: Record<string, { create?: number; modify?: number; delete?: number }>;
}

const MAX_BATCH = 1000;

interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}
interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
  release(): void;
}

function mintRequestId(): string {
  return `req_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

/** 操作条目结构校验（畸形 → 400 域，与语义校验 422 严格分立，spec 30 §2） */
function validateOperations(def: OntologyDefinition, operations: unknown[]): void {
  const issues: { index: number; message: string }[] = [];
  const typeNames = new Set(def.objectTypes.map((t) => t.apiName));
  operations.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      issues.push({ index, message: "操作必须为对象" });
      return;
    }
    const op = raw as Record<string, unknown>;
    if (op.op !== "create" && op.op !== "modify" && op.op !== "delete") {
      issues.push({ index, message: `op 必须为 create/modify/delete（得到 ${JSON.stringify(op.op)}）` });
    }
    if (typeof op.type !== "string" || !typeNames.has(op.type)) {
      issues.push({ index, message: `未知对象类型：${JSON.stringify(op.type)}` });
    }
    if (op.op === "create" && (typeof op.object !== "object" || op.object === null || Array.isArray(op.object))) {
      issues.push({ index, message: "create 操作必须含 object 对象" });
    }
    if (op.op === "modify" && (typeof op.patch !== "object" || op.patch === null || Array.isArray(op.patch))) {
      issues.push({ index, message: "modify 操作必须含 patch 对象" });
    }
    if ((op.op === "modify" || op.op === "delete") && typeof op.id !== "string") {
      issues.push({ index, message: "modify/delete 操作必须含 id 字符串" });
    }
    const extra = Object.keys(op).filter((k) => !["type", "op", "object", "id", "patch"].includes(k));
    if (extra.length > 0) issues.push({ index, message: `未知字段：${extra.join(", ")}` });
  });
  if (issues.length > 0) throw new IngestBadRequestError(issues);
}

function violationFrom(
  index: number,
  op: IngestOperation,
  e: unknown,
  def: OntologyDefinition,
): IngestConflictError | IngestValidationFailedError {
  if (e instanceof LinkRestrictedError) {
    return new IngestConflictError("LINK_RESTRICTED", e.referencers);
  }
  const vf = e instanceof ValidationFailed ? e : null;
  const pgCode = (e as { pgCode?: string }).pgCode;
  const pgConstraint = (e as { pgConstraint?: string }).pgConstraint;
  if (pgCode === "23505") {
    // 约束标识：employee.employeeNo 形态——按本体 unique 属性反查（列名含下划线，贪婪正则不可靠）
    let constraint = pgConstraint ?? "unique";
    const typeDef = def.objectTypes.find((t) => t.apiName === op.type);
    if (typeDef) {
      for (const p of typeDef.properties) {
        if (p.unique && pgConstraint === `uq_${op.type.replace(/-/g, "_")}_${p.apiName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}`) {
          constraint = `${op.type}.${p.apiName}`;
        }
      }
    }
    return new IngestConflictError("UNIQUE_CONFLICT", [
      { index, type: op.type, op: op.op, constraint, message: "duplicate" },
    ]);
  }
  const field = vf ? Object.keys(vf.fields)[0] : undefined;
  const message = vf ? Object.values(vf.fields)[0]! : (e as Error).message;
  return new IngestValidationFailedError([{ index, type: op.type, op: op.op, field, message }]);
}

/** 计数归零（整批回滚的审计条目用，spec 70 §4） */
function zeroedCounts(operations: IngestOperation[]): Record<string, { create?: number; modify?: number; delete?: number }> {
  const counts: Record<string, { create?: number; modify?: number; delete?: number }> = {};
  for (const op of operations) {
    const c = (counts[op.type] ??= {});
    c[op.op] = (c[op.op] ?? 0);
  }
  return counts;
}

/**
 * 批量接入：单事务全有或全无；成功 → {requestId, counts} + 同事务审计一条；
 * 失败 → 整批回滚 + 审计补落（计数 0）+ 抛类型化错误（违规条目清单）。
 */
export async function ingestBatch(
  pool: PgPoolLike,
  def: OntologyDefinition,
  source: string | null,
  rawOperations: unknown[],
  actor: IngestActor,
): Promise<IngestResult> {
  if (!Array.isArray(rawOperations)) throw new IngestBadRequestError([{ index: 0, message: "operations 必须为数组" }]);
  if (rawOperations.length > MAX_BATCH) throw new BatchTooLargeError(rawOperations.length);
  validateOperations(def, rawOperations);
  const operations = rawOperations as IngestOperation[];
  const requestId = mintRequestId();

  const client = await pool.connect();
  const exec = (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> =>
    client.query(sql, params).then((r) => r.rows);
  const auditImportBatch = async (counts: Record<string, Record<string, number>>): Promise<void> => {
    await exec(
      `INSERT INTO hl_audit_log (kind, subject_id, subject_kind, token_id, request_id, counts, source)
       VALUES ('import-batch', $1::uuid, $2, $3::uuid, $4, $5::jsonb, $6)`,
      [actor.subjectId, actor.subjectKind, actor.tokenId, requestId, JSON.stringify(counts), source],
    );
  };

  try {
    await client.query("BEGIN");
    const channel = await WriteChannel.load(def, exec);
    const counts: Record<string, { create?: number; modify?: number; delete?: number }> = {};
    const editIndexToOp = new Map<number, number>();

    try {
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i]!;
        const before = channel.edits.length;
        try {
          if (op.op === "create") {
            channel.create(op.type, op.object);
          } else if (op.op === "modify") {
            channel.modify(op.type, { id: op.id }, op.patch);
          } else {
            channel.delete({ id: op.id, __type: op.type });
          }
        } catch (e) {
          // 同步校验异常（必填缺失/未知属性/对象不存在/阻删预检）——直接归因当前条目
          throw violationFrom(i, op, e, def);
        }
        for (let ei = before; ei < channel.edits.length; ei++) editIndexToOp.set(ei, i);
        const c = (counts[op.type] ??= {});
        c[op.op] = (c[op.op] ?? 0) + 1;
      }
      await channel.flush();
    } catch (e) {
      // flush 落地异常：WriteOpError 携带 editIndex → 操作 index（同步异常已在上方归因）
      if (e instanceof WriteOpError) {
        const index = editIndexToOp.get(e.editIndex) ?? -1;
        const op = index >= 0 ? operations[index] : undefined;
        throw violationFrom(index >= 0 ? index : 0, op ?? { type: "?", op: "create", object: {} }, e.cause, def);
      }
      throw e;
    }

    await auditImportBatch(counts as Record<string, Record<string, number>>);
    await client.query("COMMIT");
    return { requestId, counts };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // 审计照落（计数 0——治理轨迹，spec 70 §4）；best-effort
    try {
      await auditImportBatch(zeroedCounts(operations) as Record<string, Record<string, number>>);
    } catch {
      // 审计补落失败不再掩盖原始错误
    }
    throw e;
  } finally {
    client.release();
  }
}
