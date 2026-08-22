import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sql } from "kysely";
import {
  bootstrapAdmin,
  createDb,
  issueTokenWithValue,
  runMigrations,
} from "@heirloom/engine";
import { buildDefinition } from "@heirloom/cli";
import { buildApp } from "../src/app.js";

/**
 * e2e 全量串测 —— spec 80 验收场景 S0–S11 单线走完（HTTP 全链路：
 * 认证 → push → 授权 → 动作 → 查询 → ingest → 演化 → 审计面）。
 * 本体走真实 CLI 求值路径（esbuild）；S6/S10 用场景层 push（测试内改定义）。
 */

const ADMIN_URL = process.env.HEIRLOOM_TEST_ADMIN_URL ?? "postgres://heirloom:heirloom@localhost:5433/postgres";
const dbName = `heirloom_test_${Math.random().toString(36).slice(2, 10)}`;
const dbUrl = ADMIN_URL.replace(/\/postgres$/, `/${dbName}`);

const BOOTSTRAP_TOKEN = "hlk_e2e_bootstrap_0123456789abcdef";

let db: ReturnType<typeof createDb>;
let app: Awaited<ReturnType<typeof buildApp>>;
let pool: Pool;

function inject(method: string, url: string, token?: string, body?: unknown): Promise<{ statusCode: number; json: () => any }> {
  return app.inject({
    method,
    url,
    headers: token !== undefined ? { authorization: `Bearer ${token}` } : undefined,
    payload: body,
  }) as never;
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  db = createDb(dbUrl);
  await runMigrations(db); // S0: 引擎迁移（compose 启动等价）
  const boot = await bootstrapAdmin(db, "user:admin-01"); // S0: 超管引导
  await issueTokenWithValue(db, boot.subjectId!, BOOTSTRAP_TOKEN); // S0: env 引导 token
  app = await buildApp({ databaseUrl: dbUrl });
  await app.ready();
  pool = new Pool({ connectionString: dbUrl });
});

afterAll(async () => {
  await pool?.end();
  await app?.close();
  await db?.destroy();
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe("S0 部署引导（spec 80 S0）", () => {
  it("迁移完成 → 引导超管 → env token 可调 → audit 闭环 200", async () => {
    const ok = await inject("GET", "/v1/admin/audit", BOOTSTRAP_TOKEN);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toEqual([]);
    const unauth = await inject("GET", "/v1/admin/audit");
    expect(unauth.statusCode).toBe(401);
  });
});

describe("S1 本体推送（spec 80 S1）", () => {
  it("CLI 求值（esbuild）→ PUT → revision 1 → no-op 幂等", async () => {
    const definition = await buildDefinition(new URL("../../example-ontology/ontology.ts", import.meta.url).pathname);
    const r1 = await inject("PUT", "/v1/admin/ontology", BOOTSTRAP_TOKEN, definition);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ revision: 1, changes: { auto: expect.any(Number) } });
    const r2 = await inject("PUT", "/v1/admin/ontology", BOOTSTRAP_TOKEN, definition);
    expect(r2.json()).toMatchObject({ revision: 1, noop: true });
    const pushes = (await sql`SELECT count(*)::int AS n FROM hl_audit_log WHERE kind='push'`.execute(db)).rows[0] as { n: number };
    expect(pushes.n).toBe(1); // no-op 不落审计
  });
});

describe("S2 批量接入（spec 80 S2）", () => {
  it("服务账号 + 接入授权 → 批量导入逐批审计一条", async () => {
    const svc = await inject("POST", "/v1/admin/subjects", BOOTSTRAP_TOKEN, { kind: "service", name: "svc:hr-sync" });
    const subjectId = svc.json().subjectId;
    await inject("POST", "/v1/admin/action-grants", BOOTSTRAP_TOKEN, { subjectId, action: "ingest" });
    const tok = await inject("POST", "/v1/admin/tokens", BOOTSTRAP_TOKEN, { subjectId });
    const svcToken = tok.json().token as string;

    // 部门存量先灌（员工要用）
    await inject("POST", "/v1/admin/ingest", svcToken, {
      source: "hr-sync",
      operations: [
        { type: "department", op: "create", object: { name: "平台部", budget: "1200000" } },
        { type: "department", op: "create", object: { name: "临时项目组", budget: "50000" } },
      ],
    });

    // 1400 行 → 2 批（≤1000/批）——这里用 6 行 2 批代表
    const batch1 = await inject("POST", "/v1/admin/ingest", svcToken, {
      source: "hr-sync",
      operations: Array.from({ length: 4 }, (_, i) => ({
        type: "employee", op: "create",
        object: { employeeNo: `E10${i}`, name: `员工${i}`, status: "active", salary: "500000" },
      })),
    });
    expect(batch1.statusCode).toBe(200);
    const batch2 = await inject("POST", "/v1/admin/ingest", svcToken, {
      source: "hr-sync",
      operations: [
        { type: "employee", op: "create", object: { employeeNo: "E104", name: "员工4", status: "on-leave" } },
        { type: "employee", op: "create", object: { employeeNo: "E100", name: "撞号", status: "active" } },
      ],
    });
    expect(batch2.statusCode).toBe(409); // unique 冲突整批回滚
    expect(batch2.json().error.details.violations[0]).toMatchObject({ index: 1, constraint: "employee.employeeNo" });

    const batches = (await sql`SELECT request_id, counts FROM hl_audit_log WHERE kind='import-batch' ORDER BY id`.execute(db)).rows as { request_id: string; counts: any }[];
    expect(batches).toHaveLength(3); // 部门批 + 员工批 + 回滚批（计数 0）
    expect(batches[2]!.counts).toEqual({ employee: { create: 0 } });

    // 回滚批的员工未落库
    const e104 = (await pool.query(`SELECT count(*)::int AS n FROM ontology.employee WHERE employee_no IN ('E104')`)).rows[0]!;
    expect(e104.n).toBe(0);
  });
});

describe("S3 读授权两态（spec 80 S3）", () => {
  it("hr 全类型 / manager 谓词收窄 / 零授权 = 200 空集", async () => {
    await inject("POST", "/v1/admin/groups", BOOTSTRAP_TOKEN, { name: "hr" });
    await inject("POST", "/v1/admin/groups", BOOTSTRAP_TOKEN, { name: "manager" });
    const groups = (await inject("GET", "/v1/admin/groups", BOOTSTRAP_TOKEN)).json().data as { name: string; groupId: string }[];
    const hr = groups.find((g) => g.name === "hr")!;
    const manager = groups.find((g) => g.name === "manager")!;

    const g1 = await inject("POST", "/v1/admin/read-grants", BOOTSTRAP_TOKEN, { groupId: hr.groupId, type: "employee" });
    const g2 = await inject("POST", "/v1/admin/read-grants", BOOTSTRAP_TOKEN, { groupId: manager.groupId, type: "employee", predicate: { status: { eq: "active" } } });
    expect(g1.statusCode).toBe(200);
    expect(g2.statusCode).toBe(200);

    for (const [name, group] of [["user:alice", hr], ["user:bob", manager], ["user:carol", null]] as const) {
      const sub = await inject("POST", "/v1/admin/subjects", BOOTSTRAP_TOKEN, { kind: "user", name });
      if (group) await inject("POST", `/v1/admin/groups/${group.groupId}/members`, BOOTSTRAP_TOKEN, { subjectId: sub.json().subjectId });
      const tok = await inject("POST", "/v1/admin/tokens", BOOTSTRAP_TOKEN, { subjectId: sub.json().subjectId });
      (globalThis as any)[`token:${name}`] = tok.json().token;
    }

    const alice = (await inject("POST", "/v1/objects/employee/query", (globalThis as any)["token:user:alice"], { count: true })).json();
    expect(alice.count).toBe(4); // 全体（E100–E103）
    await pool.query(`UPDATE ontology.employee SET status='on-leave' WHERE employee_no='E103'`);
    const bob2r = await inject("POST", "/v1/objects/employee/query", (globalThis as any)["token:user:bob"], { count: true });
    if (bob2r.statusCode !== 200) console.log("BOB2 ERR:", JSON.stringify(bob2r.json()));
    const st = await pool.query(`SELECT employee_no, status FROM ontology.employee ORDER BY employee_no`);
    console.log("EMPLOYEES:", JSON.stringify(st.rows));
    const gr = await pool.query(`SELECT type_api_name, predicate FROM hl_read_grants`);
    console.log("GRANTS:", JSON.stringify(gr.rows));
    expect(bob2r.json().count).toBe(3);
    const carol = (await inject("POST", "/v1/objects/employee/query", (globalThis as any)["token:user:carol"], { count: true })).json();
    expect(carol).toEqual({ data: [], count: 0 }); // 零授权 = 零行 = 空集
  });
});

describe("S4 录用正反路径（spec 80 S4）", () => {
  it("超预算 422 回滚无审计 → 修正 200 审计一条（默认填充）", async () => {
    const alice = (globalThis as any)["token:user:alice"];
    await inject("POST", "/v1/admin/action-grants", BOOTSTRAP_TOKEN, { groupByNameSkip: undefined, groupId: (await grpId("hr")), action: "hire-employee" });
    const dept = (await pool.query(`SELECT id FROM ontology.department WHERE name='平台部'`)).rows[0]!.id;

    const bad = await inject("POST", "/v1/actions/hire-employee/invoke", alice, {
      employeeNo: "E1024", name: "李四", department: dept, salary: "1500000",
      address: { street: "南京路 1 号", city: "上海", zip: "200000" },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.details.fields.salary).toContain("预算");
    const none = (await pool.query(`SELECT count(*)::int AS n FROM ontology.employee WHERE employee_no='E1024'`)).rows[0]!;
    expect(none.n).toBe(0);

    const ok = await inject("POST", "/v1/actions/hire-employee/invoke", alice, {
      employeeNo: "E1024", name: "李四", department: dept, salary: "950000",
      address: { street: "南京路 1 号", city: "上海", zip: "200000" },
    });
    expect(ok.statusCode).toBe(200);
    const audit = (await sql`SELECT params FROM hl_audit_log WHERE kind='action' AND action_api_name='hire-employee'`.execute(db)).rows[0] as { params: any };
    expect(audit.params.hiredAt).toBeTruthy(); // 动态默认 ctx.today 填充
  });
});

async function grpId(name: string): Promise<string> {
  const groups = (await inject("GET", "/v1/admin/groups", BOOTSTRAP_TOKEN)).json().data as { name: string; groupId: string }[];
  return groups.find((g) => g.name === name)!.groupId;
}

describe("S5 并发调薪（spec 80 S5）", () => {
  it("expectedUpdatedAt：先 200 后 409 回滚；审计只记成功", async () => {
    const admin = BOOTSTRAP_TOKEN; // 超管短路白名单
    const emp = (await pool.query(`SELECT id, updated_at FROM ontology.employee WHERE employee_no='E100'`)).rows[0]!;
    const old = (emp.updated_at as Date).toISOString();

    const first = await inject("POST", "/v1/actions/adjust-salary/invoke", admin, { employee: emp.id, newSalary: "600000", expectedUpdatedAt: old });
    expect(first.statusCode).toBe(200);
    const second = await inject("POST", "/v1/actions/adjust-salary/invoke", admin, { employee: emp.id, newSalary: "700000", expectedUpdatedAt: old });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("PRECONDITION_FAILED");
    const salary = (await pool.query(`SELECT salary::text s FROM ontology.employee WHERE id=$1`, [emp.id])).rows[0]!.s;
    expect(salary).toBe("600000");
    const audits = (await sql`SELECT count(*)::int AS n FROM hl_audit_log WHERE action_api_name='adjust-salary'`.execute(db)).rows[0] as { n: number };
    expect(audits.n).toBe(1);
  });
});

describe("S6 白名单两拒（spec 80 S6：场景层动作）", () => {
  it("场景层 push close-department → 引擎层/代码层两拒 + 安全日志", async () => {
    const meta = (await inject("GET", "/v1/meta/ontology", BOOTSTRAP_TOKEN)).json();
    const def = JSON.parse(JSON.stringify(meta.definition));
    def.actions.push({
      apiName: "close-department", displayName: "关闭部门", status: "active",
      params: { department: { apiName: "department", type: "ref", target: "department", status: "active", required: true, displayName: "部门" } },
      executeSource: `(ctx, { department }) => {
        if (!ctx.groups.includes("hr")) throw new PermissionDenied("非 hr 组禁止关闭部门");
        ctx.delete(department);
        return { closed: department.id };
      }`,
    });
    const pushed = await inject("PUT", "/v1/admin/ontology", BOOTSTRAP_TOKEN, def);
    expect(pushed.statusCode).toBe(200);

    // 建临时部门 + 白名单内非 hr 主体
    const tmp = await inject("POST", "/v1/actions/create-department/invoke", BOOTSTRAP_TOKEN, { name: "待删部" });
    const deptId = tmp.json().data.departmentId;
    const sub = await inject("POST", "/v1/admin/subjects", BOOTSTRAP_TOKEN, { kind: "user", name: "user:not-hr" });
    await inject("POST", "/v1/admin/action-grants", BOOTSTRAP_TOKEN, { subjectId: sub.json().subjectId, action: "close-department" });
    const tok = (await inject("POST", "/v1/admin/tokens", BOOTSTRAP_TOKEN, { subjectId: sub.json().subjectId })).json().token;

    // 1) 白名单外主体 → WHITELIST_DENIED（不进 execute）
    const outsider = (globalThis as any)["token:user:carol"];
    const d1 = await inject("POST", "/v1/actions/close-department/invoke", outsider, { department: deptId });
    expect(d1.statusCode).toBe(403);
    expect(d1.json().error.code).toBe("WHITELIST_DENIED");

    // 2) 白名单内但非 hr 组 → PERMISSION_DENIED（事务回滚）
    const d2 = await inject("POST", "/v1/actions/close-department/invoke", tok, { department: deptId });
    expect(d2.statusCode).toBe(403);
    expect(d2.json().error.code).toBe("PERMISSION_DENIED");
    const still = (await pool.query(`SELECT count(*)::int AS n FROM ontology.department WHERE id=$1`, [deptId])).rows[0]!;
    expect(still.n).toBe(1); // 回滚

    const logs = (await inject("GET", "/v1/admin/security-log?code=WHITELIST_DENIED", BOOTSTRAP_TOKEN)).json().data;
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const pd = (await inject("GET", "/v1/admin/security-log?code=PERMISSION_DENIED", BOOTSTRAP_TOKEN)).json().data;
    expect(pd.length).toBeGreaterThanOrEqual(1);
  });
});

describe("S7 链接全家桶（spec 80 S7）", () => {
  it("transfer（link 即移动）/ grant-skill（查建 RYW）/ assign（同事务引用）", async () => {
    const admin = BOOTSTRAP_TOKEN;
    const emp = (await pool.query(`SELECT id FROM ontology.employee WHERE employee_no='E101'`)).rows[0]!.id;
    const from = (await pool.query(`SELECT id FROM ontology.department WHERE name='平台部'`)).rows[0]!.id;
    const to = (await pool.query(`SELECT id FROM ontology.department WHERE name='临时项目组'`)).rows[0]!.id;

    // transfer：1:N link 即移动
    const t = await inject("POST", "/v1/actions/transfer-employee/invoke", admin, { employee: emp, toDepartment: to });
    expect(t.statusCode).toBe(200);
    const dept = (await pool.query(`SELECT department_id FROM ontology.employee WHERE id=$1`, [emp])).rows[0]!;
    expect(dept.department_id).toBe(to);
    const oldSide = (await pool.query(`SELECT count(*)::int AS n FROM ontology.employee WHERE department_id=$1`, [from])).rows[0]!;
    expect(oldSide.n).toBe(1); // 平台部还剩 E1024（S4 录的）

    // grant-skill：查建两步 + 集合语义
    const g1 = await inject("POST", "/v1/actions/grant-skill/invoke", admin, { employee: emp, skillName: "go" });
    expect(g1.statusCode).toBe(200);
    const g2 = await inject("POST", "/v1/actions/grant-skill/invoke", admin, { employee: emp, skillName: "go" });
    expect((await pool.query(`SELECT count(*)::int AS n FROM ontology.skill WHERE name='go'`)).rows[0]!.n).toBe(1);
    const links = (await pool.query(`SELECT count(*)::int AS n FROM ontology_links.employee_skills WHERE from_id=$1`, [emp])).rows[0]!;
    expect(links.n).toBe(1);

    // assign：Membership + 两条 required 链接同事务
    const proj = await inject("POST", "/v1/actions/create-project/invoke", admin, { code: "P1", title: "平台重构" });
    const projectId = proj.json().data.projectId;
    const a = await inject("POST", "/v1/actions/assign-to-project/invoke", admin, { employee: emp, project: projectId, role: "lead" });
    expect(a.statusCode).toBe(200);
    const m = (await pool.query(`SELECT employee_id, project_id FROM ontology.membership WHERE id=$1`, [a.json().data.membershipId])).rows[0]!;
    expect(m.employee_id).toBe(emp);
    expect(m.project_id).toBe(projectId);
  });
});

describe("S8 删除语义（spec 80 S8）", () => {
  it("required 链接阻删 → 清 Membership → 删除成（CASCADE/SET NULL）", async () => {
    const admin = BOOTSTRAP_TOKEN;
    const emp = (await pool.query(`SELECT id FROM ontology.employee WHERE employee_no='E101'`)).rows[0]!.id;

    // 有 Membership → 阻删
    const d1 = await inject("POST", "/v1/actions/offboard-employee/invoke", admin, { employee: emp });
    expect(d1.statusCode).toBe(409);
    expect(d1.json().error.code).toBe("LINK_RESTRICTED");
    expect(d1.json().error.details.referencers[0]).toMatchObject({ type: "membership", linkName: "employee" });

    // 清 Membership（接入端点 delete）→ 可删
    const m = (await pool.query(`SELECT id FROM ontology.membership WHERE employee_id=$1`, [emp])).rows[0]!.id;
    const del = await inject("POST", "/v1/admin/ingest", admin, { operations: [{ type: "membership", op: "delete", id: m }] });
    expect(del.statusCode).toBe(200);

    // mentee 1:1 → SET NULL；skills M:N → CASCADE
    await pool.query(`UPDATE ontology.employee SET mentor_id=$1 WHERE employee_no='E100'`, [emp]);
    const d2 = await inject("POST", "/v1/actions/offboard-employee/invoke", admin, { employee: emp });
    expect(d2.statusCode).toBe(200);
    expect((await pool.query(`SELECT count(*)::int AS n FROM ontology.employee WHERE id=$1`, [emp])).rows[0]!.n).toBe(0);
    expect((await pool.query(`SELECT mentor_id FROM ontology.employee WHERE employee_no='E100'`)).rows[0]!.mentor_id).toBeNull();
    expect((await pool.query(`SELECT count(*)::int AS n FROM ontology_links.employee_skills WHERE from_id=$1`, [emp])).rows[0]!.n).toBe(0);
  });
});

describe("S9 查询包（spec 80 S9）", () => {
  it("嵌套过滤 + 一跳 + keyset + count + include 2 跳 + 函数", async () => {
    const admin = BOOTSTRAP_TOKEN; // department 全可见（S3 未授 alice——静默收窄特性另测）
    const page1r = await inject("POST", "/v1/objects/department/query", admin, {
      filter: { and: [{ "employees.status": { eq: "active" } }, { not: { name: { contains: "临时" } } }] },
      sort: [{ field: "name", dir: "asc" }],
      limit: 1,
      count: true,
      include: ["employees", "employees.mentor"],
    });
    if (page1r.statusCode !== 200) console.log("S9 ERR:", JSON.stringify(page1r.json()));
    const page1 = page1r.json();
    expect(page1.count).toBe(1); // 平台部（临时组名排除、待删部无 active 员工）
    const dept = page1.data[0];
    expect(dept.employees.length).toBeGreaterThanOrEqual(1);
    expect(dept.employees[0]).toHaveProperty("mentor"); // include 第 2 跳挂载

    // keyset：员工面 limit 2 → nextCursor → 第 2 页无重
    const e1 = (await inject("POST", "/v1/objects/employee/query", admin, {
      sort: [{ field: "employeeNo", dir: "asc" }], limit: 2,
    })).json();
    expect(e1.data).toHaveLength(2);
    expect(e1.nextCursor).toBeTruthy();
    const e2 = (await inject("POST", "/v1/objects/employee/query", admin, {
      sort: [{ field: "employeeNo", dir: "asc" }], limit: 2, cursor: e1.nextCursor,
    })).json();
    expect(e2.data.map((x: any) => x.employeeNo)).not.toContain(e1.data[0].employeeNo);

    const deptId = dept.id;
    const roster = (await inject("POST", "/v1/functions/department-roster/invoke", admin, { department: deptId })).json();
    expect(Array.isArray(roster.data)).toBe(true);
    expect(roster.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("S10 演化小步（spec 80 S10）", () => {
  it("加可选属性 auto → revision+1；反例 required 无 default → breaking", async () => {
    const meta = (await inject("GET", "/v1/meta/ontology", BOOTSTRAP_TOKEN)).json();
    const rev = meta.revision as number;

    const next = JSON.parse(JSON.stringify(meta.definition));
    next.objectTypes.find((t: any) => t.apiName === "employee").properties.push({
      apiName: "title", displayName: "职衔", status: "active", required: false, type: "string",
    });
    const ok = await inject("PUT", "/v1/admin/ontology", BOOTSTRAP_TOKEN, next);
    expect(ok.json().revision).toBe(rev + 1);
    expect(ok.json().changes).toEqual({ auto: 1, dataValidation: 0 });

    const bad = JSON.parse(JSON.stringify(ok.json().definition ? next : next));
    const props = bad.objectTypes.find((t: any) => t.apiName === "employee").properties;
    props.find((p: any) => p.apiName === "salary").required = true;
    const rejected = await inject("PUT", "/v1/admin/ontology", BOOTSTRAP_TOKEN, bad);
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe("PUSH_REJECTED_BREAKING");
    expect(JSON.stringify(rejected.json().error.details.violations)).toMatch(/remedy/);
  });
});

describe("S11 审计与安全日志查询（spec 80 S11）", () => {
  it("管理面过滤只读；非超管 403 + 安全日志", async () => {
    const audit = (await inject("GET", "/v1/admin/audit?kind=action&action=hire-employee", BOOTSTRAP_TOKEN)).json();
    expect(audit.data.length).toBe(1); // S4 正向一条（反向回滚无审计）
    const batches = (await inject("GET", "/v1/admin/audit?kind=import-batch", BOOTSTRAP_TOKEN)).json();
    expect(batches.data.length).toBeGreaterThanOrEqual(3);

    const carol = (globalThis as any)["token:user:carol"];
    const denied = await inject("GET", "/v1/admin/audit", carol);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("ADMIN_FORBIDDEN");
    const logs = (await inject("GET", "/v1/admin/security-log?code=ADMIN_FORBIDDEN", BOOTSTRAP_TOKEN)).json();
    expect(logs.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("OpenAPI 静态面（spec 30 §5）", () => {
  it("GET /v1/meta/openapi → 3.1 文档；路径与实现路由一致", async () => {
    const doc = (await inject("GET", "/v1/meta/openapi", BOOTSTRAP_TOKEN)).json();
    expect(doc.openapi).toBe("3.1.0");
    const paths = Object.keys(doc.paths);
    for (const must of [
      "/v1/objects/{type}/query", "/v1/objects/{type}/{id}",
      "/v1/actions/{apiName}/invoke", "/v1/functions/{apiName}/invoke",
      "/v1/meta/ontology", "/v1/meta/openapi",
      "/v1/admin/ontology", "/v1/admin/ingest", "/v1/admin/audit", "/v1/admin/security-log",
      "/v1/admin/subjects", "/v1/admin/groups", "/v1/admin/read-grants", "/v1/admin/action-grants", "/v1/admin/tokens",
    ]) {
      expect(paths).toContain(must);
    }
    // 与 Fastify 实际路由一致（防文档漂移）：逐路径×方法 hasRoute 精确断言
    for (const [path, item] of Object.entries<any>(doc.paths)) {
      for (const method of Object.keys(item)) {
        expect(app.hasRoute({ method: method.toUpperCase(), url: path.replace(/\{(\w+)\}/g, ":$1") })).toBe(true);
      }
    }
  });
});
