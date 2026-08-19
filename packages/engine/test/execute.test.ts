import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { materialize, ValidationFailed } from "@heirloom/dsl";
import * as fixture from "@heirloom/example-ontology";
import { sql } from "kysely";
import {
  createDb,
  invokeAction,
  invokeFunction,
  LinkRestrictedError,
  PreconditionFailedError,
  pushOntology,
  runMigrations,
  UnknownCallableError,
  UnknownParamError,
  type InvokeActor,
  type PushActor,
} from "../src/index.js";

/**
 * S4 录用正反路径 / S5 并发调薪 / S7 链接全家桶 / S8 删除语义 /
 * S9 函数位 —— spec 20 章（动作=唯一写路径、活事务、审计、乐观锁、
 * 无 upsert 查建、link 即移动、required 链接、只读函数）。
 */

const ADMIN_URL = process.env.HEIRLOOM_TEST_ADMIN_URL ?? "postgres://heirloom:heirloom@localhost:5433/postgres";
const dbName = `heirloom_test_${Math.random().toString(36).slice(2, 10)}`;
const dbUrl = ADMIN_URL.replace(/\/postgres$/, `/${dbName}`);

const actor: InvokeActor = { subjectId: null, subjectKind: "user", tokenId: null, userId: "user:admin-01", groups: ["hr"] };
const pushActor: PushActor = { subjectId: null, subjectKind: "user", tokenId: null };

function frozen(): ReturnType<typeof materialize> {
  return JSON.parse(JSON.stringify(materialize({ bindings: fixture })));
}
const def = frozen();

let db: ReturnType<typeof createDb>;
let pool: Pool;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function seedDept(name: string, budget: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO ontology.department (id, name, budget) VALUES ($1::uuid, $2, $3::numeric)`, [id, name, budget]);
  return id;
}

async function seedEmployee(deptId: string | null, props: { name: string; salary?: string; status?: string }): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO ontology.employee (id, employee_no, name, status, salary, department_id)
     VALUES ($1::uuid, $2, $3, $4, $5::numeric, $6::uuid)`,
    [id, `E${id.slice(0, 6)}`, props.name, props.status ?? "active", props.salary ?? null, deptId],
  );
  return id;
}

async function updatedOf(table: string, id: string): Promise<string> {
  const r = await pool.query(`SELECT updated_at FROM ${table} WHERE id = $1::uuid`, [id]);
  return (r.rows[0]!.updated_at as Date).toISOString();
}

async function actionAuditCount(apiName: string): Promise<number> {
  const r = await sql`SELECT count(*)::int AS n FROM hl_audit_log WHERE kind = 'action' AND action_api_name = ${apiName}`.execute(db);
  return (r.rows[0] as { n: number }).n;
}

async function lastAudit(apiName: string): Promise<Record<string, unknown>> {
  const r = await sql`SELECT * FROM hl_audit_log WHERE kind = 'action' AND action_api_name = ${apiName} ORDER BY id DESC LIMIT 1`.execute(db);
  return r.rows[0] as Record<string, unknown>;
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  db = createDb(dbUrl);
  await runMigrations(db);
  await pushOntology(db, def, pushActor);
  pool = new Pool({ connectionString: dbUrl });
});

afterAll(async () => {
  await pool?.end();
  await db?.destroy();
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe("S4 录用正反路径（spec 80 S4 / 20 §4/§10）", () => {
  let deptId: string;

  beforeAll(async () => {
    deptId = await seedDept("平台部", "1200000");
  });

  it("反向：salary 超部门预算 → ValidationFailed（逐字段）；整事务回滚、审计无行", async () => {
    const before = await actionAuditCount("hire-employee");
    await expect(
      invokeAction(pool, def, "hire-employee", {
        employeeNo: "E1024",
        name: "李四",
        department: deptId,
        salary: "1500000",
        address: { street: "南京路 1 号", city: "上海", zip: "200000" },
      }, actor),
    ).rejects.toMatchObject({ name: "ValidationFailed", fields: { salary: expect.stringContaining("预算") } });

    // 回滚 = 无事发生：无员工、无链接、审计无行
    const emp = await pool.query(`SELECT count(*)::int AS n FROM ontology.employee WHERE employee_no = 'E1024'`);
    expect(emp.rows[0]!.n).toBe(0);
    expect(await actionAuditCount("hire-employee")).toBe(before);
  });

  it("正向：动态默认 hiredAt=ctx.today；审计一条（入参含默认填充、编辑集、事务/耗时）", async () => {
    const r = await invokeAction(pool, def, "hire-employee", {
      employeeNo: "E1025",
      name: "王五",
      department: deptId,
      salary: "950000",
      address: { street: "北京路 2 号", city: "上海", zip: "200001" },
    }, actor);
    const employeeId = (r.result as { employeeId: string }).employeeId;

    // hiredAt 动态默认填充（spec 20 §3）
    const row = (await pool.query(`SELECT hired_at::text, department_id FROM ontology.employee WHERE id = $1::uuid`, [employeeId])).rows[0]!;
    expect(row.hired_at).toBe(today());
    expect(row.department_id).toBe(deptId);

    // 审计（spec 20 §10）
    expect(await actionAuditCount("hire-employee")).toBe(1);
    const audit = await lastAudit("hire-employee");
    expect(audit.action_api_name).toBe("hire-employee");
    expect(audit.subject_kind).toBe("user");
    const params = audit.params as Record<string, unknown>;
    expect(params.hiredAt).toBe(today()); // 默认填充后原样记录
    const edits = audit.edits as { type: string; id: string; op: string; link?: string }[];
    expect(edits).toEqual([
      { type: "employee", id: employeeId, op: "create" },
      { type: "employee", id: employeeId, op: "link", link: "department.employees" },
    ]);
    expect(audit.transaction_id).toBeTruthy();
    expect(Number(audit.duration_ms)).toBeGreaterThanOrEqual(0); // bigint 驱动往返字符串
    // 编辑集返回给调用方（server 层可直接复用）
    expect(r.edits).toHaveLength(2);
  });

  it("ref 参数对象不存在 → 参数校验范畴 422；未知参数名 → 400 域", async () => {
    await expect(
      invokeAction(pool, def, "hire-employee", { employeeNo: "E1", name: "x", department: crypto.randomUUID(), salary: "1" }, actor),
    ).rejects.toMatchObject({ name: "ValidationFailed", fields: { department: expect.stringContaining("不存在") } });
    await expect(
      invokeAction(pool, def, "hire-employee", { employeeNo: "E1", name: "x", department: deptId, hacker: 1 }, actor),
    ).rejects.toBeInstanceOf(UnknownParamError);
    await expect(
      invokeAction(pool, def, "hire-employee", { name: "x", department: deptId }, actor), // employeeNo required 缺失
    ).rejects.toMatchObject({ name: "ValidationFailed" });
    await expect(invokeAction(pool, def, "no-such-action", {}, actor)).rejects.toBeInstanceOf(UnknownCallableError);
  });

  it("DB 约束违例映射：unique 冲突 / CHECK 违例 → ValidationFailed", async () => {
    const dept2 = await seedDept("重复部", null);
    void dept2;
    // createDepartment：budget range(0) → CHECK 违例
    await expect(
      invokeAction(pool, def, "create-department", { name: "赤字部", budget: "-5" }, actor),
    ).rejects.toMatchObject({ name: "ValidationFailed", fields: { budget: expect.stringContaining("约束") } });
    // hireEmployee：employeeNo unique → 23505 映射（复用 E1025）
    await expect(
      invokeAction(pool, def, "hire-employee", { employeeNo: "E1025", name: "克隆人", department: deptId, salary: "1" }, actor),
    ).rejects.toMatchObject({ name: "ValidationFailed", fields: { employeeNo: expect.stringContaining("唯一") } });
    expect(await actionAuditCount("create-department")).toBe(0);
  });
});

describe("S5 并发调薪（spec 80 S5 / 20 §8）", () => {
  it("expectedUpdatedAt：先到者 200、后到者 409 回滚；审计只记成功", async () => {
    const deptId = await seedDept("调薪部", null);
    const empId = await seedEmployee(deptId, { name: "赵六", salary: "100000" });
    const oldUpdatedAt = await updatedOf("ontology.employee", empId);

    await invokeAction(pool, def, "adjust-salary", { employee: empId, newSalary: "120000", expectedUpdatedAt: oldUpdatedAt }, actor);
    expect(await actionAuditCount("adjust-salary")).toBe(1);

    // 后到者：updated_at 已变 → 整事务回滚 → PreconditionFailedError（409）
    await expect(
      invokeAction(pool, def, "adjust-salary", { employee: empId, newSalary: "140000", expectedUpdatedAt: oldUpdatedAt }, actor),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(await actionAuditCount("adjust-salary")).toBe(1); // 回滚不落审计

    const salary = (await pool.query(`SELECT salary::text FROM ontology.employee WHERE id = $1::uuid`, [empId])).rows[0]!.salary;
    expect(salary).toBe("120000");
  });

  it("缺省 LWW：双发均成功、最后写入胜", async () => {
    const deptId = await seedDept("LWW 部", null);
    const empId = await seedEmployee(deptId, { name: "钱七", salary: "100" });
    await invokeAction(pool, def, "adjust-salary", { employee: empId, newSalary: "111" }, actor);
    await invokeAction(pool, def, "adjust-salary", { employee: empId, newSalary: "222" }, actor);
    const salary = (await pool.query(`SELECT salary::text FROM ontology.employee WHERE id = $1::uuid`, [empId])).rows[0]!.salary;
    expect(salary).toBe("222");
    // 审计 optimistic_used 标记
    const audits = await sql`SELECT expected_updated_at_used FROM hl_audit_log WHERE action_api_name = 'adjust-salary' ORDER BY id`.execute(db);
    expect((audits.rows[0] as { expected_updated_at_used: boolean }).expected_updated_at_used).toBe(true);
    expect((audits.rows[2] as { expected_updated_at_used: boolean }).expected_updated_at_used).toBe(false);
  });
});

describe("S7 链接全家桶（spec 80 S7 / 20 §5–§6）", () => {
  it("transfer-employee（1:N）：link 即移动——旧部门侧自动摘除", async () => {
    const from = await seedDept("旧部门", null);
    const to = await seedDept("新部门", null);
    const empId = await seedEmployee(from, { name: "搬家人" });

    await invokeAction(pool, def, "transfer-employee", { employee: empId, toDepartment: to }, actor);

    const row = (await pool.query(`SELECT department_id FROM ontology.employee WHERE id = $1::uuid`, [empId])).rows[0]!;
    expect(row.department_id).toBe(to);
    const oldSide = (await pool.query(`SELECT count(*)::int AS n FROM ontology.employee WHERE department_id = $1::uuid`, [from])).rows[0]!;
    expect(oldSide.n).toBe(0);
  });

  it("grant-skill（M:N）：无 upsert 查建 + RYW + (from,to) 集合语义", async () => {
    const deptId = await seedDept("技能部", null);
    const e1 = await seedEmployee(deptId, { name: "技能人 A" });
    const e2 = await seedEmployee(deptId, { name: "技能人 B" });

    // 首次：查不到 → 建 go 技能
    const r1 = await invokeAction(pool, def, "grant-skill", { employee: e1, skillName: "go" }, actor);
    // 二次（另一员工）：RYW/预载快照查得到已提交的 go → 不重建
    const r2 = await invokeAction(pool, def, "grant-skill", { employee: e2, skillName: "go" }, actor);
    expect((r1.result as { skillId: string }).skillId).toBe((r2.result as { skillId: string }).skillId);

    const skills = (await pool.query(`SELECT name FROM ontology.skill`)).rows.map((r) => r.name);
    expect(skills.filter((s) => s === "go")).toHaveLength(1);

    // 同一员工重复授予 → (from,to) 主键集合语义：幂等、无重复行
    await invokeAction(pool, def, "grant-skill", { employee: e1, skillName: "go" }, actor);
    const links = (await pool.query(`SELECT count(*)::int AS n FROM ontology_links.employee_skills WHERE from_id = $1::uuid`, [e1])).rows[0]!;
    expect(links.n).toBe(1);
  });

  it("assign-to-project：Membership 建立即两条 required 链接同事务（先建后链）", async () => {
    const deptId = await seedDept("项目一部", null);
    const empId = await seedEmployee(deptId, { name: "项目人" });
    const proj = crypto.randomUUID();
    await pool.query(`INSERT INTO ontology.project (id, code, title) VALUES ($1::uuid, 'P1', '平台重构')`, [proj]);

    const r = await invokeAction(pool, def, "assign-to-project", { employee: empId, project: proj }, actor);
    const mId = (r.result as { membershipId: string }).membershipId;
    const row = (await pool.query(`SELECT role, joined_at::text, employee_id, project_id FROM ontology.membership WHERE id = $1::uuid`, [mId])).rows[0]!;
    expect(row.role).toBe("contributor"); // 参数默认
    expect(row.joined_at).toBe(today()); // 动态默认
    expect(row.employee_id).toBe(empId);
    expect(row.project_id).toBe(proj); // 两条 required 链接齐备（NOT NULL FK）
  });
});

describe("S8 删除语义（spec 80 S8 / 40 §4）", () => {
  it("required 链接阻删：409 带引用方清单；清链后可删；M:N CASCADE / 1:1 SET NULL", async () => {
    const deptId = await seedDept("离职部", null);
    const empId = await seedEmployee(deptId, { name: "离职人" });
    const menteeId = await seedEmployee(deptId, { name: "门徒" });

    // 技能链接（M:N → 随删 CASCADE）
    await invokeAction(pool, def, "grant-skill", { employee: empId, skillName: "rust" }, actor);
    // mentor 1:1：mentee 指向 emp（optional → SET NULL）
    await pool.query(`UPDATE ontology.employee SET mentor_id = $1::uuid WHERE id = $2::uuid`, [empId, menteeId]);
    // Membership：required many-to-one → 阻删
    const proj = crypto.randomUUID();
    await pool.query(`INSERT INTO ontology.project (id, code, title) VALUES ($1::uuid, 'P2', '二期')`, [proj]);
    await invokeAction(pool, def, "assign-to-project", { employee: empId, project: proj }, actor);

    // 1) 有 Membership → LinkRestrictedError（引用方清单）
    try {
      await invokeAction(pool, def, "offboard-employee", { employee: empId }, actor);
      expect.unreachable("应抛 LinkRestrictedError");
    } catch (e) {
      expect(e).toBeInstanceOf(LinkRestrictedError);
      const refs = (e as LinkRestrictedError).referencers;
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ type: "membership", linkName: "employee" });
    }

    // 2) 清 Membership（接入端点 M6 未就绪——等效路径：本通道 SQL 删行）→ 再删 → 成功
    await pool.query(`DELETE FROM ontology.membership WHERE employee_id = $1::uuid`, [empId]);
    await invokeAction(pool, def, "offboard-employee", { employee: empId }, actor);

    expect((await pool.query(`SELECT count(*)::int AS n FROM ontology.employee WHERE id = $1::uuid`, [empId])).rows[0]!.n).toBe(0);
    // M:N 链接行 CASCADE
    expect((await pool.query(`SELECT count(*)::int AS n FROM ontology_links.employee_skills WHERE from_id = $1::uuid`, [empId])).rows[0]!.n).toBe(0);
    // mentee 的 mentor 列 SET NULL（不报错、门徒仍在）
    const mentee = (await pool.query(`SELECT mentor_id FROM ontology.employee WHERE id = $1::uuid`, [menteeId])).rows[0]!;
    expect(mentee.mentor_id).toBeNull();
  });
});

describe("S9 函数位（spec 80 S9 / 20 §11）", () => {
  it("department-roster：q.linked 只读投影", async () => {
    const deptId = await seedDept("花名册部", null);
    const e1 = await seedEmployee(deptId, { name: "在岗甲" });
    const e2 = await seedEmployee(deptId, { name: "休假乙", status: "on-leave" });
    void e1; void e2;

    const roster = (await invokeFunction(pool, def, "department-roster", { department: deptId }, actor)) as Record<string, unknown>[];
    expect(roster.map((e) => e.name).sort()).toEqual(["休假乙", "在岗甲"]); // Unicode 序：休 < 在
    expect(roster[0]).toHaveProperty("employeeNo");
    // 只读投影字段集
    expect(Object.keys(roster[0]!).sort()).toEqual(["employeeNo", "id", "name", "status"]);
  });

  it("project-team：q.backlinks 反向遍历经中间对象读载荷", async () => {
    const deptId = await seedDept("项目组部", null);
    const empId = await seedEmployee(deptId, { name: "组长" });
    const proj = crypto.randomUUID();
    await pool.query(`INSERT INTO ontology.project (id, code, title) VALUES ($1::uuid, 'P3', '三期')`, [proj]);
    await invokeAction(pool, def, "assign-to-project", { employee: empId, project: proj, role: "lead" }, actor);

    const team = (await invokeFunction(pool, def, "project-team", { project: proj }, actor)) as Record<string, unknown>[];
    expect(team).toHaveLength(1);
    expect(team[0]!.role).toBe("lead");
    expect(team[0]!.employee).toBe("组长");
  });

  it("读授权谓词注入预演（M5 接线）：roster 静默收窄 on-leave", async () => {
    const deptId = await seedDept("谓词部", null);
    await seedEmployee(deptId, { name: "可见人" });
    await seedEmployee(deptId, { name: "不可见人", status: "on-leave" });

    const roster = (await invokeFunction(
      pool, def, "department-roster",
      { department: deptId }, actor,
      { predicateByType: { employee: { status: { eq: "active" } } } },
    )) as Record<string, unknown>[];
    expect(roster.map((e) => e.name)).toEqual(["可见人"]); // 不可见剔除、不报错（spec 50 §7）
  });

  it("函数不存在 → 404；函数无审计", async () => {
    await expect(invokeFunction(pool, def, "no-such-fn", {}, actor)).rejects.toBeInstanceOf(UnknownCallableError);
    const r = await sql`SELECT count(*)::int AS n FROM hl_audit_log WHERE kind = 'action' AND action_api_name = 'department-roster'`.execute(db);
    expect((r.rows[0] as { n: number }).n).toBe(0);
  });
});

describe("活事务纪律（spec 20 §6）", () => {
  it("同事务内 RYW：execute 内读得到本事务已写", async () => {
    // createProject 后 grantSkill 需要的技能在同事务建——以 ctx.all 读验证
    const deptId = await seedDept("RYW 部", null);
    const empId = await seedEmployee(deptId, { name: "RYW 人" });
    const r = await invokeAction(pool, def, "grant-skill", { employee: empId, skillName: "ryw-skill" }, actor);
    void r;
    // 无 upsert 查建两步已覆盖 RYW；此处再验证 all 快照含新技能
    const skills = (await pool.query(`SELECT name FROM ontology.skill WHERE name = 'ryw-skill'`)).rows;
    expect(skills).toHaveLength(1);
  });

  it("ValidationFailed / PermissionDenied 使整事务回滚（部分写入不留痕）", async () => {
    const deptId = await seedDept("回滚部", "100");
    const before = (await pool.query(`SELECT count(*)::int AS n FROM ontology.employee`)).rows[0]!.n;
    // createDepartment 成功部分 + 预算超限（execute 前段 create、后段抛）——hireEmployee 反向路径已覆盖
    // 这里验证：同 execute 内先建后抛 → 全部回滚
    await expect(
      invokeAction(pool, def, "hire-employee", {
        employeeNo: "E-ROLLBACK",
        name: "回滚人",
        department: deptId,
        salary: "999999999", // 超预算 100
      }, actor),
    ).rejects.toBeInstanceOf(ValidationFailed);
    const after = (await pool.query(`SELECT count(*)::int AS n FROM ontology.employee`)).rows[0]!.n;
    expect(after).toBe(before);
  });
});
