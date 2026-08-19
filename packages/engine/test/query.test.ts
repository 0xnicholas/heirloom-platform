import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { materialize } from "@heirloom/dsl";
import * as fixture from "@heirloom/example-ontology";
import { createDb, executeQuery, pgExec, pushOntology, runMigrations, type PushActor } from "../src/index.js";

/**
 * S9 查询包（spec 80 / 30 §3.1 / 40 §6）：嵌套过滤 + 一跳链接过滤 +
 * keyset 分页（含 NULL/混合方向锥）+ count + include 2 跳 + 行级谓词
 * 注入（M5 预演：主查询/count/include/EXISTS 一致、静默收窄）。
 */

const ADMIN_URL = process.env.HEIRLOOM_TEST_ADMIN_URL ?? "postgres://heirloom:heirloom@localhost:5433/postgres";
const dbName = `heirloom_test_${Math.random().toString(36).slice(2, 10)}`;
const dbUrl = ADMIN_URL.replace(/\/postgres$/, `/${dbName}`);

const actor: PushActor = { subjectId: null, subjectKind: "user", tokenId: null };
let db: ReturnType<typeof createDb>;
let pool: Pool;

function frozen(): ReturnType<typeof materialize> {
  return JSON.parse(JSON.stringify(materialize({ bindings: fixture })));
}
const def = frozen();
const exec = () => pgExec(pool);

function q(
  request: Parameters<typeof executeQuery>[3],
  type = "employee",
  predicateByType?: Record<string, unknown>,
) {
  return executeQuery(exec(), type, def, request, predicateByType ? { predicateByType: predicateByType as never } : undefined);
}

// ── 种子数据（uuidv7 预生成：id 序 = 创建序）──

const id = {
  deptPlatform: "018f2a55-0000-7000-8000-000000000001",
  deptTemp: "018f2a55-0000-7000-8000-000000000002",
  deptDelivery: "018f2a55-0000-7000-8000-000000000003",
  deptResearch: "018f2a55-0000-7000-8000-000000000004",
  deptOps: "018f2a55-0000-7000-8000-000000000005",
  e1: "018f2a55-0000-7000-8000-000000000011",
  e2: "018f2a55-0000-7000-8000-000000000012",
  e3: "018f2a55-0000-7000-8000-000000000013",
  e4: "018f2a55-0000-7000-8000-000000000014",
  e5: "018f2a55-0000-7000-8000-000000000015",
  skillGo: "018f2a55-0000-7000-8000-000000000021",
  skillRust: "018f2a55-0000-7000-8000-000000000022",
  projectA: "018f2a55-0000-7000-8000-000000000031",
  m1: "018f2a55-0000-7000-8000-000000000041",
  m2: "018f2a55-0000-7000-8000-000000000042",
} as const;

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO ontology.department (id, name, budget) VALUES
       ($1,'平台部','1200000'), ($2,'临时项目组','50000'), ($3,'交付部','800000'), ($4,'研发中心',NULL), ($5,'运营部',NULL)`,
      [id.deptPlatform, id.deptTemp, id.deptDelivery, id.deptResearch, id.deptOps],
    );
    await client.query(
      `INSERT INTO ontology.employee (id, employee_no, name, status, salary, hired_at, certifications, address, department_id, mentor_id)
       VALUES ($1,'E001','张三','active','950000','2023-01-10',$2::text[],$3::jsonb,$4::uuid,NULL)`,
      [id.e1, ["go", "rust"], JSON.stringify({ street: "南京路 1 号", city: "上海", zip: "200000" }), id.deptPlatform],
    );
    await client.query(
      `INSERT INTO ontology.employee (id, employee_no, name, status, department_id, mentor_id)
       VALUES ($1,'E002','李四','on-leave',$2::uuid,$3::uuid)`,
      [id.e2, id.deptPlatform, id.e1],
    );
    await client.query(
      `INSERT INTO ontology.employee (id, employee_no, name, status, salary, hired_at, certifications, department_id)
       VALUES ($1,'E003','王五','offboarded','100000','2022-06-01',$2::text[],$3::uuid)`,
      [id.e3, ["go"], id.deptDelivery],
    );
    await client.query(
      `INSERT INTO ontology.employee (id, employee_no, name, status, department_id)
       VALUES ($1,'E004','赵六','on-leave',$2::uuid)`,
      [id.e4, id.deptTemp],
    );
    await client.query(
      `INSERT INTO ontology.employee (id, employee_no, name, status, salary, hired_at, department_id, mentor_id)
       VALUES ($1,'E005','钱七','active','500000','2024-03-01',$2::uuid,$3::uuid)`,
      [id.e5, id.deptResearch, id.e2],
    );
    await client.query(
      `INSERT INTO ontology.skill (id, name) VALUES ($1,'go'), ($2,'rust')`,
      [id.skillGo, id.skillRust],
    );
    await client.query(
      `INSERT INTO ontology_links.employee_skills (from_id, to_id) VALUES ($1,$2), ($1,$3), ($4,$2)`,
      [id.e1, id.skillGo, id.skillRust, id.e3],
    );
    await client.query(
      `INSERT INTO ontology.project (id, code, title, budget) VALUES ($1,'P1','平台重构',$2)`,
      [id.projectA, JSON.stringify({ amount: "1000000", currency: "CNY" })],
    );
    await client.query(
      `INSERT INTO ontology.membership (id, role, joined_at, employee_id, project_id) VALUES
       ($1,'lead','2024-01-01',$3,$5), ($2,'contributor','2024-02-01',$4,$5)`,
      [id.m1, id.m2, id.e1, id.e3, id.projectA],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  db = createDb(dbUrl);
  await runMigrations(db);
  await pushOntology(db, def, actor);
  pool = new Pool({ connectionString: dbUrl });
  await seed();
});

afterAll(async () => {
  await pool?.end();
  await db?.destroy();
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

// 静态 UUID 种子（uuidv7 形状、创建序递增）——分页断言确定性前提

describe("S9 查询包主流程（spec 80 S9 / 30 §3.1）", () => {
  it("嵌套过滤 + 一跳链接过滤 + sort + count + include 2 跳", async () => {
    const r = await q(
      {
        filter: {
          and: [
            { "employees.status": { eq: "active" } },
            { not: { name: { contains: "临时" } } },
          ],
        },
        sort: [{ field: "name", dir: "asc" }],
        count: true,
        include: ["employees", "employees.mentor"],
      },
      "department",
    );

    expect(r.count).toBe(2); // 平台部（E001 active）+ 研发中心（E005 active）
    expect(r.data).toHaveLength(2);
    expect(r.nextCursor).toBeUndefined();

    const [platform, research] = r.data as Record<string, unknown>[];
    expect(platform!.name).toBe("平台部");
    expect(platform!.budget).toBe("1200000"); // decimal 字符串

    // include employees：E001/E002（按 id 序）
    const employees = platform!.employees as Record<string, unknown>[];
    expect(employees.map((e) => e.employeeNo)).toEqual(["E001", "E002"]);

    // 标量解码：decimal 字符串 / date 字符串 / jsonb struct 对象
    const e1 = employees[0]!;
    expect(e1.salary).toBe("950000");
    expect(e1.hiredAt).toBe("2023-01-10");
    expect(e1.certifications).toEqual(["go", "rust"]);
    expect(e1.address).toEqual({ street: "南京路 1 号", city: "上海", zip: "200000" });
    expect(typeof e1.createdAt).toBe("string");

    // include 第 2 跳：E002.mentor = E001；E001.mentor = null
    expect(employees[0]!.mentor).toBeNull();
    expect((employees[1]!.mentor as Record<string, unknown>).employeeNo).toBe("E001");

    // 研发中心：E005（mentor = E002，无谓词时可见）
    expect(research!.name).toBe("研发中心");
    const r5 = (research!.employees as Record<string, unknown>[])[0]!;
    expect(r5.employeeNo).toBe("E005");
    expect((r5.mentor as Record<string, unknown>).employeeNo).toBe("E002");
  });

  it("project include memberships.employee（反向多值 + 正向单值两跳）；struct 投影", async () => {
    const r = await q({ include: ["memberships.employee"] }, "project");
    const proj = r.data[0]!;
    expect(proj.code).toBe("P1");
    expect(proj.budget).toEqual({ amount: "1000000", currency: "CNY" }); // jsonb struct
    const ms = proj.memberships as Record<string, unknown>[];
    expect(ms.map((m) => m.role)).toEqual(["lead", "contributor"]);
    expect((ms[0]!.employee as Record<string, unknown>).employeeNo).toBe("E001");
    expect((ms[1]!.employee as Record<string, unknown>).employeeNo).toBe("E003");
  });

  it("membership 过滤 memberships.role=lead 反查 project", async () => {
    const r = await q({ filter: { "memberships.role": { eq: "lead" } } }, "project");
    expect(r.data.map((p) => p.code)).toEqual(["P1"]);
  });
});

describe("keyset 分页（spec 40 §6：NULL 恒最大、混合方向锥）", () => {
  it("salary DESC（NULLS FIRST）：跨页序 = 全局序、无重无漏、末页无游标", async () => {
    const pages: string[] = [];
    let cursor: string | undefined;
    let pages_ = 0;
    do {
      const r = await q({ sort: [{ field: "salary", dir: "desc" }], limit: 2, cursor });
      pages.push(...(r.data as Record<string, unknown>[]).map((e) => e.employeeNo as string));
      cursor = r.nextCursor;
      pages_++;
      expect(pages_).toBeLessThan(10); // 防死循环
    } while (cursor);
    // DESC NULLS FIRST：NULL（id 序）→ 950000 → 500000 → 100000
    expect(pages).toEqual(["E002", "E004", "E001", "E005", "E003"]);
  });

  it("salary ASC（NULLS LAST）：null 游标值 → 平键后比 id", async () => {
    const pages: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await q({ sort: [{ field: "salary", dir: "asc" }], limit: 2, cursor });
      pages.push(...(r.data as Record<string, unknown>[]).map((e) => e.employeeNo as string));
      cursor = r.nextCursor;
    } while (cursor);
    expect(pages).toEqual(["E003", "E005", "E001", "E002", "E004"]);
  });

  it("混合方向 + 平键：name asc, salary desc", async () => {
    const r = await q({ sort: [{ field: "name", dir: "asc" }, { field: "salary", dir: "desc" }] });
    expect((r.data as Record<string, unknown>[]).map((e) => e.name)).toEqual([
      "张三", "李四", "王五", "赵六", "钱七",
    ]);
  });

  it("count 不受分页影响：翻页全程恒定", async () => {
    const first = await q({ sort: [{ field: "id", dir: "asc" }], limit: 2, count: true });
    expect(first.count).toBe(5);
    const second = await q({ sort: [{ field: "id", dir: "asc" }], limit: 2, count: true, cursor: first.nextCursor });
    expect(second.count).toBe(5);
    expect(second.data).toHaveLength(2);
  });

  it("默认 limit 100：5 行一页尽收、无游标", async () => {
    const r = await q({});
    expect(r.data).toHaveLength(5);
    expect(r.nextCursor).toBeUndefined();
  });
});

describe("一跳链接过滤（四种物理落位全走通，spec 40 §6）", () => {
  it("fk-own（many-to-one/1:1 正向）: department.name / mentor.name", async () => {
    const r = await q({ filter: { "department.name": { eq: "平台部" } } });
    expect((r.data as Record<string, unknown>[]).map((e) => e.employeeNo)).toEqual(["E001", "E002"]);

    const r2 = await q({ filter: { "mentor.name": { startsWith: "张" } } });
    expect((r2.data as Record<string, unknown>[]).map((e) => e.employeeNo)).toEqual(["E002"]);
  });

  it("fk-many（one-to-many 正向 / many-to-one 反向）: employees.status / memberships.role", async () => {
    const r = await q({ filter: { "employees.status": { eq: "active" } } }, "department");
    expect((r.data as Record<string, unknown>[]).map((d) => d.name)).toEqual(["平台部", "研发中心"]);

    const r2 = await q({ filter: { "memberships.role": { eq: "lead" } } });
    expect((r2.data as Record<string, unknown>[]).map((e) => e.employeeNo)).toEqual(["E001"]);
  });

  it("mn（many-to-many）: skills.name", async () => {
    const r = await q({ filter: { "skills.name": { eq: "go" } } });
    expect((r.data as Record<string, unknown>[]).map((e) => e.employeeNo).sort()).toEqual(["E001", "E003"]);
  });

  it("not + 一跳：无 active 员工的部门（含零员工部门）", async () => {
    const r = await q({ filter: { not: { "employees.status": { eq: "active" } } }, sort: [{ field: "name", dir: "asc" }] }, "department");
    expect((r.data as Record<string, unknown>[]).map((d) => d.name)).toEqual(["临时项目组", "交付部", "运营部"]);
  });
});

describe("数组与标量算子（真 PG 行为）", () => {
  it("contains-any 数组重叠", async () => {
    const r = await q({ filter: { certifications: { "contains-any": ["rust", "k8s"] } } });
    expect((r.data as Record<string, unknown>[]).map((e) => e.employeeNo)).toEqual(["E001"]);
  });

  it("eq:null / neq:null / in / decimal 精确比较（字符串数字序）", async () => {
    const nulls = await q({ filter: { salary: { eq: null } }, sort: [{ field: "id", dir: "asc" }] });
    expect((nulls.data as Record<string, unknown>[]).map((e) => e.employeeNo)).toEqual(["E002", "E004"]);

    const gt = await q({ filter: { salary: { gt: "100000" } }, sort: [{ field: "salary", dir: "asc" }] });
    expect((gt.data as Record<string, unknown>[]).map((e) => e.employeeNo)).toEqual(["E005", "E001"]); // 500000 < 950000（数值序而非字典序）

    const inSet = await q({ filter: { status: { in: ["on-leave", "offboarded"] } }, sort: [{ field: "id", dir: "asc" }] });
    expect((inSet.data as Record<string, unknown>[]).map((e) => e.employeeNo)).toEqual(["E002", "E003", "E004"]);
  });

  it("LIKE 通配符按字面匹配（% 转义后非量词）", async () => {
    const r = await q({ filter: { name: { contains: "%" } } });
    expect(r.data).toHaveLength(0);
  });
});

describe("行级谓词注入（M5 预演：spec 40 §9 / 50 §7 静默收窄）", () => {
  it("include 多值跳：不可见员工剔除、多值变短", async () => {
    const r = await q(
      { include: ["employees"] },
      "department",
      { employee: { status: { eq: "active" } } },
    );
    const byName = new Map((r.data as Record<string, unknown>[]).map((d) => [d.name as string, d.employees as Record<string, unknown>[]]));
    expect(byName.get("平台部")!.map((e) => e.employeeNo)).toEqual(["E001"]); // E002 on-leave 剔除
    expect(byName.get("研发中心")!.map((e) => e.employeeNo)).toEqual(["E005"]);
    expect(byName.get("交付部")).toEqual([]); // E003 offboarded → 空集
    expect(byName.get("运营部")).toEqual([]); // 零员工部门 → 空集
  });

  it("include 单值跳：不可见导师变 null（不丢父行）", async () => {
    const r = await q(
      { filter: { employeeNo: { eq: "E005" } }, include: ["mentor"] },
      "employee",
      { employee: { status: { eq: "active" } } },
    );
    const rows = r.data as Record<string, unknown>[];
    expect(rows.map((e) => e.employeeNo)).toEqual(["E005"]); // E005 active → 主查询可见
    expect(rows[0]!.mentor).toBeNull(); // E002 on-leave → 单值变 null（spec 50 §7）
  });

  it("一跳过滤 EXISTS 内谓词同源生效：交集空 → 200 空集（静默收窄，spec 50 §5）", async () => {
    const r = await q(
      { filter: { "employees.status": { eq: "on-leave" } }, count: true },
      "department",
      { employee: { status: { eq: "active" } } },
    );
    expect(r.data).toEqual([]);
    expect(r.count).toBe(0);
  });

  it("主查询谓词：零授权 = 零行 = 空集，与空过滤器同形", async () => {
    const r = await q({ count: true }, "department", { department: { name: { eq: "不存在的部门" } } });
    expect(r.data).toEqual([]);
    expect(r.count).toBe(0);
  });
});
