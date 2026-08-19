import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sql } from "kysely";
import { materialize } from "@heirloom/dsl";
import * as fixture from "@heirloom/example-ontology";
import {
  createDb,
  pushOntology,
  PushRejectedError,
  runMigrations,
  type PushActor,
} from "../src/index.js";

/**
 * S1 本体推送 + S10 演化小步（spec 80）：
 * 空库收敛冻结本体 → no-op 幂等 → 加可选属性（自动档）→
 * 收紧无默认（拒绝档）→ 带数据删列（数据校验档拒）。
 */

const ADMIN_URL = process.env.HEIRLOOM_TEST_ADMIN_URL ?? "postgres://heirloom:heirloom@localhost:5433/postgres";
const dbName = `heirloom_test_${Math.random().toString(36).slice(2, 10)}`;
const dbUrl = ADMIN_URL.replace(/\/postgres$/, `/${dbName}`);

const actor: PushActor = { subjectId: null, subjectKind: "user", tokenId: null };
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  db = createDb(dbUrl);
  await runMigrations(db);
});

afterAll(async () => {
  await db?.destroy();
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

function frozen(): ReturnType<typeof materialize> {
  return JSON.parse(JSON.stringify(materialize({ bindings: fixture })));
}

async function auditCount(): Promise<number> {
  const r = await sql`SELECT count(*)::int AS n FROM hl_audit_log WHERE kind = 'push'`.execute(db);
  return (r.rows[0] as { n: number }).n;
}

async function columnExists(table: string, col: string): Promise<boolean> {
  const r = await sql`SELECT 1 FROM information_schema.columns WHERE table_schema = 'ontology' AND table_name = ${table} AND column_name = ${col}`.execute(db);
  return r.rows.length > 0;
}

describe("S1 push：空库收敛冻结本体（spec 60 §2–§3）", () => {
  it("首次 push → revision 1，建表齐备，push 审计一行", async () => {
    const result = await pushOntology(db, frozen(), actor);
    expect(result.revision).toBe(1);
    expect(result.noop).toBe(false);
    expect(result.changes!.auto).toBeGreaterThan(10); // 5 类型 + 2 struct + 8 动作 + 2 函数 + 链接
    expect(await auditCount()).toBe(1);

    for (const t of ["department", "employee", "skill", "project", "membership"]) {
      expect(await columnExists(t, "id"), `${t}.id`).toBe(true);
    }
    // 业务键 / decimal / 数组 / struct / enum 物理落位
    expect(await columnExists("employee", "employee_no")).toBe(true);
    expect(await columnExists("employee", "salary")).toBe(true);
    expect(await columnExists("employee", "certifications")).toBe(true);
    expect(await columnExists("employee", "address")).toBe(true);
    // M:N 链接表
    const links = await sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'ontology_links' AND table_name = 'employee_skills'`.execute(db);
    expect(links.rows.length).toBe(1);
    // 1:N：FK 落在 N 侧（employee.department_id）
    expect(await columnExists("employee", "department_id")).toBe(true);
    // many-to-one required：membership.employee_id NOT NULL
    const nn = await sql`SELECT is_nullable FROM information_schema.columns WHERE table_schema='ontology' AND table_name='membership' AND column_name='employee_id'`.execute(db);
    expect((nn.rows[0] as { is_nullable: string }).is_nullable).toBe("NO");
    // 1:1 自引用：employee.mentor_id + UNIQUE
    const mentor = await sql`SELECT 1 FROM pg_constraint c JOIN pg_class t ON c.conrelid = t.oid JOIN pg_namespace n ON t.relnamespace = n.oid WHERE n.nspname='ontology' AND t.relname='employee' AND c.contype='u' AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=t.oid AND attname='mentor_id')::smallint]`.execute(db);
    expect(mentor.rows.length).toBe(1);
  });

  it("重复推同一期望态 → no-op：不涨 revision、不落审计（spec 60 §3）", async () => {
    const before = await auditCount();
    const result = await pushOntology(db, frozen(), actor);
    expect(result).toEqual({ revision: 1, noop: true });
    expect(await auditCount()).toBe(before);
  });
});

describe("S10 演化：三档矩阵落点（spec 60 §4）", () => {
  it("加可选属性 → 自动档 ADD COLUMN（存量 NULL），revision +1", async () => {
    const def = frozen();
    const emp = def.objectTypes.find((t) => t.apiName === "employee")!;
    emp.properties.push({ apiName: "title", displayName: "职称", type: "string", status: "active", required: false });
    const result = await pushOntology(db, def, actor);
    expect(result.revision).toBe(2);
    expect(result.changes).toEqual({ auto: 1, dataValidation: 0 });
    expect(await columnExists("employee", "title")).toBe(true);
    const nullable = await sql`SELECT is_nullable FROM information_schema.columns WHERE table_schema='ontology' AND table_name='employee' AND column_name='title'`.execute(db);
    expect((nullable.rows[0] as { is_nullable: string }).is_nullable).toBe("YES");
  });

  it("可选 → required 无 default → 拒绝档 422（整事务拒、revision 不动）", async () => {
    const def = frozen();
    const emp = def.objectTypes.find((t) => t.apiName === "employee")!;
    emp.properties.find((p) => p.apiName === "salary")!.required = true;
    await expect(pushOntology(db, def, actor)).rejects.toMatchObject({
      code: "PUSH_REJECTED_BREAKING",
      violations: [expect.objectContaining({ remedy: expect.stringContaining("default") })],
    });
    const r = await sql`SELECT revision FROM hl_ontology WHERE id = 1`.execute(db);
    expect(Number((r.rows[0] as { revision: string | number }).revision)).toBe(2);
  });

  it("带数据删属性 → 数据校验档拒（存量非空）；清值后 → 过", async () => {
    await sql.raw(`INSERT INTO ontology.employee (id, employee_no, name, title) VALUES (gen_random_uuid(), 'E001', '张三', '高工')`).execute(db);

    const def = frozen();
    const emp = def.objectTypes.find((t) => t.apiName === "employee")!;
    emp.properties = emp.properties.filter((p) => p.apiName !== "title");
    await expect(pushOntology(db, def, actor)).rejects.toMatchObject({
      code: "PUSH_REJECTED_DATA_VALIDATION",
    });

    await sql`UPDATE ontology.employee SET title = NULL`.execute(db);
    const result = await pushOntology(db, def, actor);
    expect(result.revision).toBe(3);
    expect(await columnExists("employee", "title")).toBe(false);
  });

  it("enum 删值有存量引用 → 升格拒绝档（spec 60 §4.3）", async () => {
    const def = frozen();
    const emp = def.objectTypes.find((t) => t.apiName === "employee")!;
    const status = emp.properties.find((p) => p.apiName === "status")!;
    // 存量行 status='active'（列默认）；删掉 active
    status.values = ["on-leave", "offboarded"];
    await expect(pushOntology(db, def, actor)).rejects.toMatchObject({
      code: "PUSH_REJECTED_BREAKING",
      violations: [expect.objectContaining({ violation: expect.stringContaining("active") })],
    });
  });

  it("加 unique 且存量冲突 → 数据校验档拒（索引扫存量）", async () => {
    await sql.raw(`INSERT INTO ontology.employee (id, employee_no, name) VALUES (gen_random_uuid(), 'E002', '重名'), (gen_random_uuid(), 'E003', '重名')`).execute(db);
    const def = frozen();
    const emp = def.objectTypes.find((t) => t.apiName === "employee")!;
    emp.properties.find((p) => p.apiName === "name")!.unique = true;
    await expect(pushOntology(db, def, actor)).rejects.toMatchObject({
      code: "PUSH_REJECTED_DATA_VALIDATION",
    });
  });

  it("结构校验先行拒绝（400 域）", async () => {
    const def = frozen();
    def.objectTypes[0]!.apiName = "BadCase";
    await expect(pushOntology(db, def, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
