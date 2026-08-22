import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { materialize } from "@heirloom/dsl";
import * as fixture from "@heirloom/example-ontology";
import { sql } from "kysely";
import {
  createDb,
  createSubject,
  grantRead,
  pushOntology,
  PushRejectedError,
  runMigrations,
  type PushActor,
} from "../src/index.js";

/**
 * 演化三档矩阵全分支（spec 60 §4/§7，锚 80 S10）：
 * push.test 覆盖主干（空库/no-op/加可选/收紧无默认/带数据删列）——
 * 此处补齐：enum 删值两态、加 unique、收紧 range、加 required 带 default、
 * 放宽、改标量类型、重命名（=删+加）、删链接、struct 形状、悬空谓词联动。
 *
 * 每用例基于**当前生效定义**克隆修改（用例间有顺序依赖的存量演化——
 * 这正是演化场景的常态：小步收敛）。
 */

const ADMIN_URL = process.env.HEIRLOOM_TEST_ADMIN_URL ?? "postgres://heirloom:heirloom@localhost:5433/postgres";
const dbName = `heirloom_test_${Math.random().toString(36).slice(2, 10)}`;
const dbUrl = ADMIN_URL.replace(/\/postgres$/, `/${dbName}`);

const actor: PushActor = { subjectId: null, subjectKind: "user", tokenId: null };

type Def = ReturnType<typeof materialize>;

function frozen(): Def {
  return JSON.parse(JSON.stringify(materialize({ bindings: fixture })));
}

/** 当前生效定义克隆（演化基线 = 权威态，spec 60 §2.2） */
async function current(): Promise<Def> {
  const r = await sql`SELECT definition FROM hl_ontology WHERE id = 1`.execute(db);
  return JSON.parse(JSON.stringify((r.rows[0] as { definition: Def }).definition));
}

let db: ReturnType<typeof createDb>;
let pool: Pool;

async function revision(): Promise<number> {
  const r = await sql`SELECT revision FROM hl_ontology WHERE id = 1`.execute(db);
  return Number((r.rows[0] as { revision: number }).revision);
}

async function expectReject(expected: Def, wantCode: string, wantMatch?: RegExp): Promise<void> {
  const before = await revision();
  try {
    await pushOntology(db, expected, actor);
    expect.unreachable(`应抛 ${wantCode}`);
  } catch (e) {
    expect(e).toBeInstanceOf(PushRejectedError);
    const err = e as PushRejectedError;
    expect(err.code).toBe(wantCode);
    if (wantMatch) {
      expect(JSON.stringify(err.violations)).toMatch(wantMatch);
    }
  }
  expect(await revision()).toBe(before); // 整事务拒绝：revision 不变
}

async function seedEmployee(no: string, extra: { status?: string; salary?: string; name?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO ontology.employee (id, employee_no, name, status, salary) VALUES ($1::uuid, $2, $3, $4, $5::numeric)`,
    [id, no, extra.name ?? no, extra.status ?? "active", extra.salary ?? null],
  );
  return id;
}

function propOf(d: Def, type: string, prop: string): Record<string, any> {
  return d.objectTypes.find((t) => t.apiName === type)!.properties.find((p) => p.apiName === prop)!;
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  db = createDb(dbUrl);
  await runMigrations(db);
  await pushOntology(db, frozen(), actor);
  pool = new Pool({ connectionString: dbUrl });
});

afterAll(async () => {
  await pool?.end();
  await db?.destroy();
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe("自动档（spec 60 §4.1）", () => {
  it("enum 加值 = 超集 → auto", async () => {
    const next = await current();
    propOf(next, "employee", "status").values = ["active", "on-leave", "offboarded", "contractor"];
    const before = await revision();
    const r = await pushOntology(db, next, actor);
    expect(r.revision).toBe(before + 1);
    expect(r.changes).toEqual({ auto: 1, dataValidation: 0 });
    await seedEmployee("E-A1", { status: "contractor" });
  });

  it("放宽 required → 可选（DROP NOT NULL）→ auto", async () => {
    const next = await current();
    propOf(next, "membership", "joinedAt").required = false;
    const r = await pushOntology(db, next, actor);
    expect(r.changes).toEqual({ auto: 1, dataValidation: 0 });
  });

  it("扩 length → 替换放宽 CHECK → auto", async () => {
    const next = await current();
    propOf(next, "employee", "name").length = { min: 1, max: 200 };
    const r = await pushOntology(db, next, actor);
    expect(r.changes).toEqual({ auto: 1, dataValidation: 0 });
  });
});

describe("数据校验档（spec 60 §4.2：存量不过 → 整事务拒）", () => {
  it("加 unique：存量冲突 → 拒；清值后 → 过", async () => {
    await seedEmployee("E-U1", { name: "重名者" });
    await seedEmployee("E-U2", { name: "重名者" });

    const next = await current();
    propOf(next, "employee", "name").unique = true;
    await expectReject(next, "PUSH_REJECTED_DATA_VALIDATION");

    await pool.query(`UPDATE ontology.employee SET name = employee_no WHERE name = '重名者'`);
    const r = await pushOntology(db, next, actor);
    expect(r.changes).toEqual({ auto: 0, dataValidation: 1 });
  });

  it("收紧 range：存量违例 → 拒；修数后 → 过", async () => {
    await seedEmployee("E-R1", { salary: "5000000" });
    const next = await current();
    propOf(next, "employee", "salary").range = { min: "0", max: "1000000" };
    await expectReject(next, "PUSH_REJECTED_DATA_VALIDATION");

    await pool.query(`UPDATE ontology.employee SET salary = '100000' WHERE employee_no = 'E-R1'`);
    const r = await pushOntology(db, next, actor);
    expect(r.changes).toEqual({ auto: 0, dataValidation: 1 });
  });

  it("加 required 带静态 default：存量 NULL → 拒（不过即拒）；清值后 → 过", async () => {
    const next = await current();
    const p = propOf(next, "employee", "hiredAt");
    p.required = true;
    p.default = { kind: "static", value: "2020-01-01" };
    // 种子存量 hired_at 存在 NULL → 数据校验拒（spec 60 §4.2：尝试执行、存量不过即拒）
    await expectReject(next, "PUSH_REJECTED_DATA_VALIDATION");

    await pool.query(`UPDATE ontology.employee SET hired_at = '2021-06-01' WHERE hired_at IS NULL`);
    const r = await pushOntology(db, next, actor);
    expect(r.changes).toEqual({ auto: 0, dataValidation: 1 });
    const nulls = (await pool.query(`SELECT count(*)::int AS n FROM ontology.employee WHERE hired_at IS NULL`)).rows[0]!;
    expect(nulls.n).toBe(0);
  });

  it("enum 删值且无存量引用 → 过", async () => {
    await pool.query(`UPDATE ontology.employee SET status = 'active' WHERE status = 'contractor'`);
    const next = await current();
    propOf(next, "employee", "status").values = ["active", "on-leave", "offboarded"];
    const r = await pushOntology(db, next, actor);
    expect(r.changes).toEqual({ auto: 0, dataValidation: 1 });
  });

  it("enum 删值且有存量引用 → 升格拒绝档（remedy 指路一次性动作）", async () => {
    await seedEmployee("E-E1", { status: "on-leave" });
    const next = await current();
    propOf(next, "employee", "status").values = ["active", "offboarded"];
    await expectReject(next, "PUSH_REJECTED_BREAKING", /enum 删值|一次性动作/);
  });

  it("删链接：存在非空链接 → 拒；清链后 → 过", async () => {
    const m1 = await seedEmployee("E-M1");
    await pool.query(`UPDATE ontology.employee SET mentor_id = $1::uuid WHERE employee_no = 'E-M1'`, [m1]);
    const next = await current();
    const employee = next.objectTypes.find((t) => t.apiName === "employee")!;
    employee.links = employee.links.filter((l) => l.apiName !== "mentor");
    await expectReject(next, "PUSH_REJECTED_DATA_VALIDATION");

    await pool.query(`UPDATE ontology.employee SET mentor_id = NULL`);
    const r = await pushOntology(db, next, actor);
    expect(r.changes!.dataValidation).toBeGreaterThanOrEqual(1);
    const col = (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='ontology' AND table_name='employee' AND column_name='mentor_id'`)).rows;
    expect(col).toHaveLength(0);
  });

  it("struct 形状收紧：存量违例 → 拒（JS 侧逐行校验）", async () => {
    await pool.query(
      `INSERT INTO ontology.employee (id, employee_no, name, address) VALUES ($1::uuid, 'E-S1', 'S1', $2::jsonb)`,
      [crypto.randomUUID(), JSON.stringify({ street: "x", city: "y", zip: "1234567890" })],
    );
    const next = await current();
    const addr = next.structs.find((s) => s.apiName === "address")!;
    addr.properties.find((p) => p.apiName === "zip")!.length = { min: 5, max: 6 };
    await expectReject(next, "PUSH_REJECTED_DATA_VALIDATION", /形状|不符|值/);
  });
});

describe("拒绝档（spec 60 §4.3：出路建议必带）", () => {
  it("改标量类型 json → string → 拒（remedy 三通道）", async () => {
    const next = await current();
    propOf(next, "employee", "metadata").type = "string";
    await expectReject(next, "PUSH_REJECTED_BREAKING", /改标量类型|分多次 push/);
  });

  it("重命名 apiName = 删+加：可选属性、有存量数据 → 删侧数据校验拒", async () => {
    const next = await current();
    const employee = next.objectTypes.find((t) => t.apiName === "employee")!;
    const email = employee.properties.find((p) => p.apiName === "email")!;
    email.apiName = "contactEmail";
    await pool.query(`UPDATE ontology.employee SET email = 'a@b.c' WHERE email IS NULL AND employee_no = 'E-U1'`);
    await expectReject(next, "PUSH_REJECTED_DATA_VALIDATION");
    // 清值后重命名过（删空列 + 加可选列）
    await pool.query(`UPDATE ontology.employee SET email = NULL WHERE email IS NOT NULL`);
    const r = await pushOntology(db, next, actor);
    expect(r.changes!.dataValidation).toBeGreaterThanOrEqual(1);
  });
});

describe("push 联动校验（spec 60 §7 fail-closed）", () => {
  it("行级谓词 → 被删属性悬空 → 拒（码同拒绝档 + remedy 先解除引用）", async () => {
    const subject = await createSubject(db, { kind: "user", name: "user:evo-grant" });
    await grantRead(db, await current(), { subjectId: subject.subjectId, typeApiName: "employee", predicate: { status: { eq: "active" } } });

    const next = await current();
    const employee = next.objectTypes.find((t) => t.apiName === "employee")!;
    employee.properties = employee.properties.filter((p) => p.apiName !== "status");
    await expectReject(next, "PUSH_REJECTED_BREAKING", /悬空|read-grant|解除引用/);
  });

  it("悬空谓词清理后：删属性走正常数据校验路径", async () => {
    await sql`DELETE FROM hl_read_grants WHERE predicate IS NOT NULL`.execute(db);
    const next = await current();
    const employee = next.objectTypes.find((t) => t.apiName === "employee")!;
    employee.properties = employee.properties.filter((p) => p.apiName !== "status");
    await expectReject(next, "PUSH_REJECTED_DATA_VALIDATION", /delete-property|存量存在非空/);
    await pool.query(`UPDATE ontology.employee SET status = NULL WHERE status IS NOT NULL`);
    const r = await pushOntology(db, next, actor);
    expect(r.changes!.dataValidation).toBeGreaterThanOrEqual(1);
  });
});

describe("status 生命周期（spec 60 §6：纯元数据、零强制）", () => {
  it("deprecated 仍可正常读写；meta-change 归自动档", async () => {
    const next = await current();
    propOf(next, "employee", "metadata").status = "deprecated";
    const r = await pushOntology(db, next, actor);
    expect(r.changes).toEqual({ auto: 1, dataValidation: 0 });
    await pool.query(`UPDATE ontology.employee SET metadata = '{"k":1}'::jsonb WHERE employee_no = 'E-U1'`);
    const row = (await pool.query(`SELECT metadata FROM ontology.employee WHERE employee_no = 'E-U1'`)).rows[0]!;
    expect(row.metadata).toEqual({ k: 1 });
  });
});
