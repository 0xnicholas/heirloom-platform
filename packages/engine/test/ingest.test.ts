import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { materialize } from "@heirloom/dsl";
import * as fixture from "@heirloom/example-ontology";
import { sql } from "kysely";
import {
  BatchTooLargeError,
  createSubject,
  IngestBadRequestError,
  IngestConflictError,
  IngestValidationFailedError,
  ingestBatch,
  createDb,
  pushOntology,
  runMigrations,
  type IngestActor,
  type PushActor,
} from "../src/index.js";

/**
 * S2 批量接入（spec 80 S2 / 70 §2–§4 / 30 §4.2）：单事务全有或全无、
 * 逐类型计数回执、每请求恰好一条 import-batch 审计（含回滚——计数 0）、
 * unique 冲突 409 违规清单（index 定位）、413 批量上限、S8 前置的接入删除。
 */

const ADMIN_URL = process.env.HEIRLOOM_TEST_ADMIN_URL ?? "postgres://heirloom:heirloom@localhost:5433/postgres";
const dbName = `heirloom_test_${Math.random().toString(36).slice(2, 10)}`;
const dbUrl = ADMIN_URL.replace(/\/postgres$/, `/${dbName}`);

const pushActor: PushActor = { subjectId: null, subjectKind: "user", tokenId: null };
const actor: IngestActor = { subjectId: null, subjectKind: "service", tokenId: null };

function frozen(): ReturnType<typeof materialize> {
  return JSON.parse(JSON.stringify(materialize({ bindings: fixture })));
}
const def = frozen();

let db: ReturnType<typeof createDb>;
let pool: Pool;

async function importBatches(): Promise<{ requestId: string; counts: unknown }[]> {
  const r = await sql`SELECT request_id, counts FROM hl_audit_log WHERE kind = 'import-batch' ORDER BY id`.execute(db);
  return (r.rows as unknown as Record<string, unknown>[]).map((row) => ({
    requestId: row.request_id as string,
    counts: row.counts,
  }));
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  db = createDb(dbUrl);
  await runMigrations(db);
  await pushOntology(db, def, pushActor);
  const svc = await createSubject(db, { kind: "service", name: "svc:hr-sync" });
  actor.subjectId = svc.subjectId;
  pool = new Pool({ connectionString: dbUrl });

  // 域前置：部门 + 一名员工 + membership（S8 删除路径用）
  await pool.query(`INSERT INTO ontology.department (id, name, budget) VALUES ($1::uuid, '平台部', '100')`, [deptId]);
  await pool.query(
    `INSERT INTO ontology.employee (id, employee_no, name, status, department_id) VALUES ($1::uuid, 'E000', '存量人', 'active', $2::uuid)`,
    [empId, deptId],
  );
  await pool.query(`INSERT INTO ontology.project (id, code, title) VALUES ($1::uuid, 'P0', '前置项目')`, [projectId]);
  await pool.query(
    `INSERT INTO ontology.membership (id, role, joined_at, employee_id, project_id) VALUES ($1::uuid, 'lead', '2024-01-01', $2::uuid, $3::uuid)`,
    [membershipId, empId, projectId],
  );
});

const deptId = crypto.randomUUID();
const empId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const membershipId = crypto.randomUUID();

afterAll(async () => {
  await pool?.end();
  await db?.destroy();
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe("S2 批量接入（spec 80 S2）", () => {
  it("成功批：create+modify+delete 混合 → 计数回执 + 审计一条（requestId/counts/source）", async () => {
    const r = await ingestBatch(
      pool,
      def,
      "hr-sync",
      [
        { type: "employee", op: "create", object: { employeeNo: "E101", name: "张三", status: "active" } },
        { type: "employee", op: "create", object: { employeeNo: "E102", name: "李四", status: "on-leave" } },
        { type: "employee", op: "modify", id: empId, patch: { status: "on-leave" } },
        { type: "membership", op: "delete", id: membershipId }, // S8：FK 持方自身删除无额外动作
      ],
      actor,
    );
    expect(r.requestId).toMatch(/^req_/);
    expect(r.counts).toEqual({
      employee: { create: 2, modify: 1 },
      membership: { delete: 1 },
    });

    // 落库验证
    const rows = (await pool.query(`SELECT employee_no, status FROM ontology.employee WHERE employee_no IN ('E101','E102') ORDER BY employee_no`)).rows;
    expect(rows).toEqual([{ employee_no: "E101", status: "active" }, { employee_no: "E102", status: "on-leave" }]);
    const patched = (await pool.query(`SELECT status FROM ontology.employee WHERE id = $1::uuid`, [empId])).rows[0]!;
    expect(patched.status).toBe("on-leave");
    expect((await pool.query(`SELECT count(*)::int AS n FROM ontology.membership`)).rows[0]!.n).toBe(0);

    // 审计恰好一条
    const batches = await importBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.requestId).toBe(r.requestId);
    expect(batches[0]!.counts).toEqual(r.counts);
    const source = (await sql`SELECT source FROM hl_audit_log WHERE kind = 'import-batch'`.execute(db)).rows[0] as { source: string };
    expect(source.source).toBe("hr-sync");
  });

  it("unique 冲突 → 整批回滚 + 409 违规清单（index 定位）+ 审计补落计数 0", async () => {
    const batchesBefore = (await importBatches()).length;
    const employeesBefore = (await pool.query(`SELECT count(*)::int AS n FROM ontology.employee`)).rows[0]!.n;

    try {
      await ingestBatch(
        pool,
        def,
        "hr-sync",
        [
          { type: "employee", op: "create", object: { employeeNo: "E201", name: "新人甲", status: "active" } },
          { type: "employee", op: "create", object: { employeeNo: "E101", name: "撞号者", status: "active" } }, // 与首批 E101 冲突
          { type: "employee", op: "create", object: { employeeNo: "E202", name: "新人乙", status: "active" } },
        ],
        actor,
      );
      expect.unreachable("应抛 IngestConflictError");
    } catch (e) {
      expect(e).toBeInstanceOf(IngestConflictError);
      const err = e as IngestConflictError;
      expect(err.code).toBe("UNIQUE_CONFLICT");
      expect(err.violations).toEqual([
        { index: 1, type: "employee", op: "create", constraint: "employee.employeeNo", message: "duplicate" },
      ]);
    }

    // 整批回滚：无新增；审计照落（计数 0）
    const employeesAfter = (await pool.query(`SELECT count(*)::int AS n FROM ontology.employee`)).rows[0]!.n;
    expect(employeesAfter).toBe(employeesBefore);
    const batches = await importBatches();
    expect(batches).toHaveLength(batchesBefore + 1);
    expect(batches.at(-1)!.counts).toEqual({ employee: { create: 0 } }); // 计数为 0（spec 70 §4）
  });

  it("校验失败（CHECK/必填/对象不存在）→ 422 违规清单 + 回滚", async () => {
    await expect(
      ingestBatch(pool, def, null, [{ type: "employee", op: "create", object: { name: "缺工号" } }], actor),
    ).rejects.toMatchObject({
      name: "IngestValidationFailedError",
      violations: [{ index: 0, type: "employee", op: "create", field: "employeeNo", message: expect.stringContaining("必填") }],
    });
    await expect(
      ingestBatch(pool, def, null, [{ type: "employee", op: "modify", id: crypto.randomUUID(), patch: { name: "幽灵" } }], actor),
    ).rejects.toMatchObject({
      name: "IngestValidationFailedError",
      violations: [{ index: 0, op: "modify", message: expect.stringContaining("不存在") }],
    });
    // 状态恢复（供后续用例）
    await pool.query(`UPDATE ontology.employee SET status = 'active' WHERE id = $1::uuid`, [empId]);
  });

  it("required 链接阻删（接入删除）→ 409 LINK_RESTRICTED 带引用方清单", async () => {
    // 重建 membership（required many-to-one → 阻删员工）
    await pool.query(
      `INSERT INTO ontology.membership (id, role, joined_at, employee_id, project_id) VALUES ($1::uuid, 'contributor', '2024-02-01', $2::uuid, $3::uuid)`,
      [membershipId, empId, projectId],
    );
    try {
      await ingestBatch(pool, def, null, [{ type: "employee", op: "delete", id: empId }], actor);
      expect.unreachable("应抛 IngestConflictError");
    } catch (e) {
      expect(e).toBeInstanceOf(IngestConflictError);
      const err = e as IngestConflictError;
      expect(err.code).toBe("LINK_RESTRICTED");
      expect(err.violations).toEqual([{ type: "membership", id: membershipId, linkName: "employee" }]);
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM ontology.employee WHERE id = $1::uuid`, [empId])).rows[0]!.n).toBe(1);
  });

  it("批量上限 >1000 → 413；结构畸形 → 400", async () => {
    const ops = Array.from({ length: 1001 }, (_, i) => ({ type: "employee", op: "create" as const, object: { employeeNo: `X${i}`, name: `批量${i}` } }));
    await expect(ingestBatch(pool, def, null, ops, actor)).rejects.toBeInstanceOf(BatchTooLargeError);

    await expect(
      ingestBatch(pool, def, null, [{ type: "employee", op: "upsert", object: {} }], actor),
    ).rejects.toBeInstanceOf(IngestBadRequestError);
    await expect(
      ingestBatch(pool, def, null, [{ type: "no-such-type", op: "create", object: {} }], actor),
    ).rejects.toBeInstanceOf(IngestBadRequestError);
    await expect(
      ingestBatch(pool, def, null, [{ type: "employee", op: "create", object: {}, hacker: 1 }], actor),
    ).rejects.toBeInstanceOf(IngestBadRequestError);
  });
});
