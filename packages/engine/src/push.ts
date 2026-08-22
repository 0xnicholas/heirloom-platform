/**
 * push 收敛执行器 —— diff → 分类 → 单事务收敛（spec 60 §2–§3）。
 *
 * 权威三件持久化：当前生效定义 + 单调 revision + push 审计行。
 * 幂等：期望态 == 当前生效 → no-op（不涨 revision、不落审计）。
 * 并发：hl_ontology 行锁串行化。
 */
import { sql } from "kysely";
import type { Kysely } from "kysely";
import {
  assertValidDefinition,
  DefinitionValidationError,
  type OntologyDefinition,
  type PropertyDef,
  type StructDef,
} from "@heirloom/dsl";
import { canonical, describeChange, diffOntology, sameDefinition, type Change } from "./changes.js";
import { classifyAll, type ClassifiedChange, type Tier } from "./classify.js";
import { buildOps, type Op } from "./ddl.js";
import { objectTable, quoteIdent, columnName } from "./naming.js";

export interface PushActor {
  subjectId: string | null;
  subjectKind: "user" | "service" | null;
  tokenId: string | null;
}

export interface PushViolation {
  kind: string;
  target: string;
  violation?: string;
  remedy?: string;
}

export class PushRejectedError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "PUSH_REJECTED_BREAKING" | "PUSH_REJECTED_DATA_VALIDATION",
    readonly violations: PushViolation[],
  ) {
    super(code);
    this.name = "PushRejectedError";
  }
}

export interface PushResult {
  revision: number;
  noop: boolean;
  changes?: { auto: number; dataValidation: number };
}

interface OntologyRow {
  revision: number;
  definition: OntologyDefinition;
}

const KIND_ORDER: Record<Change["kind"], number> = {
  "add-object-type": 0,
  "add-struct": 1,
  "add-property": 2,
  "add-link": 3,
  "modify-property": 4,
  "modify-link": 4,
  "modify-struct": 4,
  "modify-action": 4,
  "modify-function": 4,
  "meta-change": 4,
  "delete-link": 5,
  "delete-property": 6,
  "delete-object-type": 7,
  "delete-struct": 8,
  "delete-action": 9,
  "delete-function": 9,
  "add-action": 9,
  "add-function": 9,
};

export async function pushOntology(
  db: Kysely<any>,
  expected: OntologyDefinition,
  actor: PushActor,
): Promise<PushResult> {
  // 1. 定义结构校验先行拒绝（400 域，spec 60 §7 / 30 §4.1）
  try {
    assertValidDefinition(expected);
  } catch (e) {
    if (e instanceof DefinitionValidationError) {
      throw new PushRejectedError(
        "BAD_REQUEST",
        e.issues.map((i) => ({ kind: "definition", target: i.path, violation: i.message })),
      );
    }
    throw e;
  }

  return db.transaction().execute(async (trx) => {
    // 2. 行锁串行化（后到者基于最新生效定义 diff）
    const row = (
      await sql`SELECT revision, definition FROM hl_ontology WHERE id = 1 FOR UPDATE`.execute(trx)
    ).rows[0] as OntologyRow | undefined;
    if (!row) throw new Error("hl_ontology 未初始化：先跑引擎迁移");
    const current = row.definition as OntologyDefinition;

    // 3. no-op（幂等）
    if (sameDefinition(current, expected)) {
      return { revision: Number(row.revision), noop: true } satisfies PushResult;
    }

    // 4. diff + 分类（按依赖相位排序：建表 → 加列/链接 → 变更 → 拆链接 → 删列 → 删表）
    const changes = diffOntology(current, expected).sort(
      (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
    );
    const classified = classifyAll(changes);

    const breaking = classified.filter((c) => c.tier === "breaking");
    if (breaking.length > 0) {
      throw new PushRejectedError(
        "PUSH_REJECTED_BREAKING",
        breaking.map((c) => ({
          kind: c.change.kind,
          target: describeChange(c.change),
          remedy: c.remedy,
        })),
      );
    }

    // 5. 联动校验：运行时谓词 → 被删属性悬空（fail-closed，spec 60 §7）
    await checkDanglingPredicates(trx, changes);

    // 6. 执行（DDL + 探测交错；任何违例 → 整事务回滚）
    const structs = new Map(expected.structs.map((s) => [s.apiName, s]));
    const violations: PushViolation[] = [];
    for (const cc of classified) {
      const ops: Op[] = buildOps(cc, expected.structs);
      for (const op of ops) {
        if (op.type === "sql") {
          try {
            await sql.raw(op.sql).execute(trx);
          } catch (e) {
            // 数据校验档：PG 原生约束违例（unique/CHECK/NOT NULL/FK）→ 映射为整事务拒绝（spec 60 §4.2）
            const pgCode = (e as { code?: string }).code;
            if (
              cc.tier === "data-validation" &&
              pgCode &&
              ["23505", "23514", "23502", "23503"].includes(pgCode)
            ) {
              violations.push({
                kind: "data-validation",
                target: describeChange(cc.change),
                violation: (e as { detail?: string; message?: string }).detail ?? (e as { message?: string }).message ?? "约束违例",
                remedy: "存量数据不符新约束：先修数据（一次性动作或重灌）再收紧",
              });
              throw new PushRejectedError("PUSH_REJECTED_DATA_VALIDATION", violations);
            }
            throw e;
          }
        } else {
          const n = ((await sql.raw(op.sql).execute(trx)).rows[0] as { n: number } | undefined)?.n ?? 0;
          if (n > 0) {
            violations.push({
              kind: op.escalateBreaking ? "breaking" : "data-validation",
              target: describeChange(cc.change),
              violation: op.violation,
              remedy: op.remedy,
            });
            throw new PushRejectedError(
              op.escalateBreaking ? "PUSH_REJECTED_BREAKING" : "PUSH_REJECTED_DATA_VALIDATION",
              violations,
            );
          }
        }
      }
      // struct 形状变更：引用方存量逐行校验（JS 侧）
      if (cc.change.kind === "modify-struct") {
        await validateStructReferences(trx, cc.change.to, expected.objectTypes, violations);
      }
    }

    // 7. 收敛：revision +1、定义持久化、push 审计行
    const newRevision = Number(row.revision) + 1;
    const counts = countByTier(classified);
    await sql`UPDATE hl_ontology SET revision = ${newRevision}, definition = ${JSON.stringify(expected)}::jsonb, updated_at = now() WHERE id = 1`.execute(trx);
    await sql`INSERT INTO hl_audit_log (kind, subject_id, subject_kind, token_id, revision_from, revision_to, change_counts)
      VALUES ('push', ${actor.subjectId}::uuid, ${actor.subjectKind}, ${actor.tokenId}::uuid, ${Number(row.revision)}, ${newRevision}, ${JSON.stringify(counts)}::jsonb)`.execute(trx);

    return { revision: newRevision, noop: false, changes: counts } satisfies PushResult;
  });
}

function countByTier(classified: ClassifiedChange[]): { auto: number; dataValidation: number } {
  let auto = 0;
  let dataValidation = 0;
  for (const c of classified) {
    if (c.tier === "auto") auto++;
    else if (c.tier === "data-validation") dataValidation++;
  }
  return { auto, dataValidation };
}

/** 行级谓词引用被删属性 → 悬空拒绝（spec 60 §7 / 50 §9） */
async function checkDanglingPredicates(trx: Kysely<any>, changes: Change[]): Promise<void> {
  const removedProps = new Set(
    changes
      .filter((c): c is Extract<Change, { kind: "delete-property" }> => c.kind === "delete-property")
      .map((c) => `${c.type}.${c.prop.apiName}`),
  );
  const removedTypes = new Set(
    changes.filter((c) => c.kind === "delete-object-type").map((c) => (c as { type: string }).type),
  );
  if (removedProps.size === 0 && removedTypes.size === 0) return;

  const grants = (await sql`SELECT id, type_api_name, predicate FROM hl_read_grants WHERE predicate IS NOT NULL`.execute(trx)).rows as {
    id: string;
    type_api_name: string;
    predicate: unknown;
  }[];
  const dangling: PushViolation[] = [];
  for (const g of grants) {
    const text = JSON.stringify(g.predicate);
    for (const rp of removedProps) {
      const [type, prop] = rp.split(".");
      if (g.type_api_name === type && new RegExp(`"${prop}"`).test(text)) {
        dangling.push({
          kind: "breaking",
          target: `read-grant(${g.id})`,
          violation: `谓词引用被删属性 ${rp}`,
          remedy: "先解除引用（删/改谓词）再推送（spec 60 §7 fail-closed）",
        });
      }
    }
    if (removedTypes.has(g.type_api_name)) {
      dangling.push({
        kind: "breaking",
        target: `read-grant(${g.id})`,
        violation: `谓词挂在被删类型 ${g.type_api_name}`,
        remedy: "先解除引用（删/改谓词）再推送",
      });
    }
  }
  if (dangling.length > 0) throw new PushRejectedError("PUSH_REJECTED_BREAKING", dangling);
}

/** struct 形状变更 → 引用列存量逐行校验（数据校验档语义） */
async function validateStructReferences(
  trx: Kysely<any>,
  struct: StructDef,
  types: { apiName: string; properties: PropertyDef[] }[],
  violations: PushViolation[],
): Promise<void> {
  const referencing = types.flatMap((t) =>
    t.properties
      .filter((p) => p.struct === struct.apiName)
      .map((p) => ({ type: t.apiName, prop: p.apiName, isArray: !!p.array })),
  );
  for (const ref of referencing) {
    const col = quoteIdent(columnName(ref.prop));
    const rows = (
      await sql.raw(`SELECT ${col} AS v FROM ${objectTable(ref.type)} WHERE ${col} IS NOT NULL`).execute(trx)
    ).rows as { v: unknown }[];
    let bad = 0;
    for (const r of rows) {
      const values = ref.isArray ? (Array.isArray(r.v) ? r.v : []) : [r.v];
      for (const v of values) if (!structValueOk(v, struct)) bad++;
    }
    if (bad > 0) {
      violations.push({
        kind: "data-validation",
        target: `struct.${struct.apiName}（引用 ${ref.type}.${ref.prop}）`,
        violation: `存量 ${bad} 个值不符新形状`,
        remedy: "先修数据（一次性动作或重灌）再收紧形状",
      });
      throw new PushRejectedError("PUSH_REJECTED_DATA_VALIDATION", violations);
    }
  }
}

/** JS 侧 struct 形状校验（字段存在性 + 标量类型 + length/range/enum 成员） */
function structValueOk(value: unknown, struct: StructDef): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  for (const p of struct.properties) {
    const v = obj[p.apiName];
    if (v === undefined) {
      if (p.required) return false;
      continue;
    }
    // 长度约束（string/enum 元素或标量）
    if (p.length && typeof v === "string") {
      if (p.length.min !== undefined && v.length < p.length.min) return false;
      if (p.length.max !== undefined && v.length > p.length.max) return false;
    }
    // 枚举成员
    if (p.type === "enum" && p.values && (typeof v !== "string" || !p.values.includes(v))) return false;
    switch (p.type) {
      case "string":
        if (typeof v !== "string") return false;
        break;
      case "boolean":
        if (typeof v !== "boolean") return false;
        break;
      case "integer":
      case "float":
        if (typeof v !== "number") return false;
        if (p.range) {
          if (p.range.min !== undefined && v < Number(p.range.min)) return false;
          if (p.range.max !== undefined && v > Number(p.range.max)) return false;
        }
        break;
      case "decimal":
        if (typeof v !== "string" || !/^-?\d+(\.d+)?$/.test(v)) return false;
        if (p.range) {
          const num = Number(v);
          if (p.range.min !== undefined && num < Number(p.range.min)) return false;
          if (p.range.max !== undefined && num > Number(p.range.max)) return false;
        }
        break;
      case "struct":
        if (!structValueOk(v, { apiName: p.struct ?? "", displayName: "", status: "active", properties: [] })) return false;
        break;
      default:
        break;
    }
  }
  return true;
}

export { canonical };
