import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { materialize } from "@heirloom/dsl";
import * as fixture from "@heirloom/example-ontology";
import {
  bootstrapAdmin,
  createDb,
  createGroup,
  createSubject,
  addGroupMember,
  grantAction,
  grantRead,
  issueToken,
  pushOntology,
  revokeToken,
  runMigrations,
  type PushActor,
} from "@heirloom/engine";
import { buildApp } from "../src/app.js";

/**
 * HTTP 面集成（spec 30）：语义面五件套 + 管理面（push/ingest/审计/安全日志/
 * 主体/组/授权/token）+ 认证/授权/错误信封——fastify inject 走真 PG。
 */

const ADMIN_URL = process.env.HEIRLOOM_TEST_ADMIN_URL ?? "postgres://heirloom:heirloom@localhost:5433/postgres";
const dbName = `heirloom_test_${Math.random().toString(36).slice(2, 10)}`;
const dbUrl = ADMIN_URL.replace(/\/postgres$/, `/${dbName}`);

const pushActor: PushActor = { subjectId: null, subjectKind: "user", tokenId: null };
function frozen(): ReturnType<typeof materialize> {
  return JSON.parse(JSON.stringify(materialize({ bindings: fixture })));
}

let db: ReturnType<typeof createDb>;
let app: Awaited<ReturnType<typeof buildApp>>;
let pool: Pool;

let adminToken = "";
let svcToken = "";
let hrToken = "";
let deptId = "";

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function inject(method: string, url: string, token: string, body?: unknown): Promise<{
  statusCode: number;
  json: () => Record<string, unknown>;
}> {
  return app.inject({ method, url, headers: auth(token), payload: body }) as never;
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  db = createDb(dbUrl);
  await runMigrations(db);

  // S0-lite：引导超管 + 签发 PAT
  const boot = await bootstrapAdmin(db, "user:admin-01");
  adminToken = (await issueToken(db, boot.subjectId!)).token;

  // 服务账号 + 接入授权（spec 70 §2）
  const svc = await createSubject(db, { kind: "service", name: "svc:hr-sync" });
  await grantAction(db, { subjectId: svc.subjectId, actionApiName: "ingest" });
  svcToken = (await issueToken(db, svc.subjectId)).token;

  // hr 组用户（动作白名单 + 读授权）
  const hr = await createGroup(db, "hr");
  const hrUser = await createSubject(db, { kind: "user", name: "user:alice" });
  await addGroupMember(db, hr.groupId, hrUser.subjectId);
  await grantAction(db, { groupId: hr.groupId, actionApiName: "hire-employee" });
  await grantRead(db, frozen(), { groupId: hr.groupId, typeApiName: "employee" });
  await grantRead(db, frozen(), { groupId: hr.groupId, typeApiName: "department" });
  hrToken = (await issueToken(db, hrUser.subjectId)).token;

  // 无授权用户（S3 零授权）
  const nobody = await createSubject(db, { kind: "user", name: "user:nobody" });
  void nobody;

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

describe("S1 push over HTTP（spec 30 §4.1）", () => {
  it("PUT 定义 → 200 {revision, changes}；重复 → noop", async () => {
    const r1 = await inject("PUT", "/v1/admin/ontology", adminToken, frozen());
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ revision: 1, changes: { auto: expect.any(Number) } });

    const r2 = await inject("PUT", "/v1/admin/ontology", adminToken, frozen());
    expect(r2.json()).toMatchObject({ revision: 1, noop: true });

    const meta = await inject("GET", "/v1/meta/ontology", adminToken);
    expect(meta.statusCode).toBe(200);
    expect((meta.json() as { revision: number }).revision).toBe(1);
  });

  it("非超管 push → 403 ADMIN_FORBIDDEN + 安全日志", async () => {
    const r = await inject("PUT", "/v1/admin/ontology", hrToken, frozen());
    expect(r.statusCode).toBe(403);
    expect((r.json() as { error: { code: string } }).error.code).toBe("ADMIN_FORBIDDEN");
    const log = await inject("GET", "/v1/admin/security-log?code=ADMIN_FORBIDDEN", adminToken);
    expect((log.json() as { data: unknown[] }).data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("认证（spec 30 §2 / 50 §4）", () => {
  it("缺失/无效/吊销 token → 401 信封 + 安全日志", async () => {
    const no = await app.inject({ method: "GET", url: "/v1/meta/ontology" });
    expect(no.statusCode).toBe(401);
    expect((no.json() as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");

    const bad = await app.inject({ method: "GET", url: "/v1/meta/ontology", headers: auth("hlk_forged") });
    expect(bad.statusCode).toBe(401);

    // 吊销即时生效
    const t = await inject("POST", "/v1/admin/tokens", adminToken, { subject: "user:admin-01" });
    const { tokenId, token } = t.json() as { tokenId: string; token: string };
    expect(token).toMatch(/^hlk_/);
    const ok = await app.inject({ method: "GET", url: "/v1/meta/ontology", headers: auth(token) });
    expect(ok.statusCode).toBe(200);
    const revoked = await inject("DELETE", `/v1/admin/tokens/${tokenId}`, adminToken);
    expect(revoked.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/v1/meta/ontology", headers: auth(token) });
    expect(after.statusCode).toBe(401);
  });

  it("畸形 JSON → 400 BAD_REQUEST（与 422 分立）", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/objects/employee/query",
      headers: { ...auth(adminToken), "content-type": "application/json" },
      payload: "{not json",
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });
});

describe("S4 动作 over HTTP（spec 30 §3.3）", () => {
  it("hire-employee：白名单组可调 → 200 {data}；422 逐字段；404 未知动作", async () => {
    const dept = await inject("POST", "/v1/actions/create-department/invoke", adminToken, { name: "平台部", budget: "1200000" });
    expect(dept.statusCode).toBe(200);
    deptId = ((dept.json() as { data: { departmentId: string } }).data).departmentId;

    const ok = await inject("POST", "/v1/actions/hire-employee/invoke", hrToken, {
      employeeNo: "E1024",
      name: "李四",
      department: deptId,
      salary: "950000",
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { data: { employeeId: string } }).data.employeeId).toBeTruthy();

    // 超预算 → 422 VALIDATION_FAILED details.fields
    const bad = await inject("POST", "/v1/actions/hire-employee/invoke", hrToken, {
      employeeNo: "E1025",
      name: "王五",
      department: deptId,
      salary: "1500000",
    });
    expect(bad.statusCode).toBe(422);
    const e = (bad.json() as { error: { code: string; details: { fields: Record<string, string> } } }).error;
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.details.fields.salary).toContain("预算");

    const nf = await inject("POST", "/v1/actions/no-such/invoke", hrToken, {});
    expect(nf.statusCode).toBe(404);
  });

  it("白名单外主体 → 403 WHITELIST_DENIED + 安全日志（不进 execute）", async () => {
    const r = await inject("POST", "/v1/actions/adjust-salary/invoke", adminToken, {});
    // 超管短路可过白名单——用无授权主体验证：先建 nobody token
    const t = await inject("POST", "/v1/admin/tokens", adminToken, { subject: "user:nobody" });
    const nobodyToken = (t.json() as { token: string }).token;
    const denied = await inject("POST", "/v1/actions/hire-employee/invoke", nobodyToken, {
      employeeNo: "E999", name: "x", department: deptId,
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: { code: string } }).error.code).toBe("WHITELIST_DENIED");
    const log = await inject("GET", "/v1/admin/security-log?code=WHITELIST_DENIED", adminToken);
    expect((log.json() as { data: unknown[] }).data.length).toBeGreaterThanOrEqual(1);
    expect(r.statusCode).toBe(422); // 超管过白名单、缺参数 → 422（证明短路语义）
  });
});

describe("S3 查询 over HTTP（spec 30 §3.1）", () => {
  it("query：hr 全类型可见；谓词收窄走授权装配", async () => {
    const r = await inject("POST", "/v1/objects/employee/query", hrToken, {
      sort: [{ field: "employeeNo", dir: "asc" }],
      count: true,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { data: Record<string, unknown>[]; count: number };
    expect(body.data.map((e) => e.employeeNo)).toEqual(["E1024"]);
    expect(body.count).toBe(1);
    expect(body.data[0]!.salary).toBe("950000"); // decimal 字符串
  });

  it("单对象 GET + include + If-Match；404/409", async () => {
    const list = await inject("POST", "/v1/objects/employee/query", hrToken, { filter: { employeeNo: { eq: "E1024" } } });
    const emp = (list.json() as { data: Record<string, unknown>[] }).data[0]!;
    const id = emp.id as string;
    const updatedAt = emp.updatedAt as string;

    const got = await inject("GET", `/v1/objects/employee/${id}?include=department`, hrToken);
    expect(got.statusCode).toBe(200);
    const row = (got.json() as { data: Record<string, unknown> }).data;
    expect((row.department as Record<string, unknown>).name).toBe("平台部");

    const stale = await app.inject({
      method: "GET",
      url: `/v1/objects/employee/${id}`,
      headers: { ...auth(hrToken), "if-match": "2000-01-01T00:00:00.000Z" },
    });
    expect(stale.statusCode).toBe(409);

    const miss = await inject("GET", `/v1/objects/employee/${crypto.randomUUID()}`, hrToken);
    expect(miss.statusCode).toBe(404);
  });

  it("未知类型 → 404；查询体越限 → 422；零授权 → 200 空集", async () => {
    const t = await inject("POST", "/v1/admin/tokens", adminToken, { subject: "user:nobody" });
    const nobodyToken = (t.json() as { token: string }).token;

    const nf = await inject("POST", "/v1/objects/no-such/query", hrToken, {});
    expect(nf.statusCode).toBe(404);

    const bad = await inject("POST", "/v1/objects/employee/query", hrToken, { limit: 1001 });
    expect(bad.statusCode).toBe(422);
    expect((bad.json() as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");

    const empty = await inject("POST", "/v1/objects/employee/query", nobodyToken, { count: true });
    expect(empty.statusCode).toBe(200); // 零授权 = 200 空集（永不 403）
    expect(empty.json()).toEqual({ data: [], count: 0 });
  });
});

describe("S2 ingest over HTTP（spec 30 §4.2 / 80 S2）", () => {
  it("服务账号（接入授权）→ 200 {requestId, counts}；审计一条", async () => {
    const r = await inject("POST", "/v1/admin/ingest", svcToken, {
      source: "hr-sync",
      operations: [
        { type: "employee", op: "create", object: { employeeNo: "E2001", name: "批量甲", status: "active" } },
        { type: "employee", op: "create", object: { employeeNo: "E2002", name: "批量乙", status: "on-leave" } },
      ],
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { requestId: string; counts: Record<string, unknown> };
    expect(body.requestId).toMatch(/^req_/);
    expect(body.counts).toEqual({ employee: { create: 2 } });

    const audit = await inject("GET", `/v1/admin/audit?kind=import-batch&requestId=${body.requestId}`, adminToken);
    const rows = (audit.json() as { data: { requestId: string; counts: unknown }[] }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.counts).toEqual(body.counts);
  });

  it("unique 冲突 → 409 UNIQUE_CONFLICT violations（index 定位）+ 整批回滚", async () => {
    const before = (await pool.query(`SELECT count(*)::int AS n FROM ontology.employee`)).rows[0]!.n;
    const r = await inject("POST", "/v1/admin/ingest", svcToken, {
      operations: [
        { type: "employee", op: "create", object: { employeeNo: "E2003", name: "新人", status: "active" } },
        { type: "employee", op: "create", object: { employeeNo: "E2001", name: "撞号", status: "active" } },
      ],
    });
    expect(r.statusCode).toBe(409);
    const e = (r.json() as { error: { code: string; details: { violations: unknown[] } } }).error;
    expect(e.code).toBe("UNIQUE_CONFLICT");
    expect(e.details.violations).toEqual([
      { index: 1, type: "employee", op: "create", constraint: "employee.employeeNo", message: "duplicate" },
    ]);
    const after = (await pool.query(`SELECT count(*)::int AS n FROM ontology.employee`)).rows[0]!.n;
    expect(after).toBe(before);
  });

  it("超上限 → 413；无接入授权（普通用户）→ 403", async () => {
    const ops = Array.from({ length: 1001 }, (_, i) => ({ type: "employee", op: "create", object: { employeeNo: `X${i}`, name: `x${i}` } }));
    const big = await inject("POST", "/v1/admin/ingest", svcToken, { operations: ops });
    expect(big.statusCode).toBe(413);
    expect((big.json() as { error: { code: string } }).error.code).toBe("BATCH_TOO_LARGE");

    const no = await inject("POST", "/v1/admin/ingest", hrToken, { operations: [] });
    expect(no.statusCode).toBe(403);
  });
});

describe("S9 函数 over HTTP（spec 30 §3.4）", () => {
  it("department-roster：只读投影 + 读授权收窄", async () => {
    const r = await inject("POST", "/v1/functions/department-roster/invoke", hrToken, { department: deptId });
    expect(r.statusCode).toBe(200);
    const roster = (r.json() as { data: Record<string, unknown>[] }).data;
    expect(roster.map((e) => e.employeeNo)).toEqual(["E1024"]); // hr 组可见员工

    const nf = await inject("POST", "/v1/functions/no-such/invoke", hrToken, {});
    expect(nf.statusCode).toBe(404);
  });
});

describe("S11 审计/安全日志查询（spec 30 §4 / 80 S11）", () => {
  it("过滤 + keyset；非超管 → 403", async () => {
    const audit = await inject("GET", "/v1/admin/audit?kind=action&action=hire-employee", adminToken);
    expect(audit.statusCode).toBe(200);
    const rows = (audit.json() as { data: { kind: string; actionApiName: string | null }[] }).data;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.kind === "action" && r.actionApiName === "hire-employee")).toBe(true);

    const denied = await inject("GET", "/v1/admin/audit", hrToken);
    expect(denied.statusCode).toBe(403);
  });
});

describe("管理面 CRUD（spec 30 §4）", () => {
  it("subjects/groups/read-grants/action-grants 生命周期", async () => {
    const sub = await inject("POST", "/v1/admin/subjects", adminToken, { kind: "user", name: "user:lifecycle" });
    expect(sub.statusCode).toBe(200);
    const subjectId = (sub.json() as { subjectId: string }).subjectId;

    const grp = await inject("POST", "/v1/admin/groups", adminToken, { name: "lifecycle" });
    const groupId = (grp.json() as { groupId: string }).groupId;

    const add = await inject("POST", `/v1/admin/groups/${groupId}/members`, adminToken, { subjectId });
    expect(add.statusCode).toBe(200);

    const rg = await inject("POST", "/v1/admin/read-grants", adminToken, { subjectId, type: "employee", predicate: { status: { eq: "active" } } });
    expect(rg.statusCode).toBe(200);
    const badRg = await inject("POST", "/v1/admin/read-grants", adminToken, { subjectId, type: "employee", predicate: { "mentor.name": { eq: "x" } } });
    expect(badRg.statusCode).toBe(422); // 谓词禁链接游走

    const ag = await inject("POST", "/v1/admin/action-grants", adminToken, { subjectId, action: "adjust-salary" });
    expect(ag.statusCode).toBe(200);

    const lists = await inject("GET", "/v1/admin/read-grants", adminToken);
    expect((lists.json() as { data: unknown[] }).data.length).toBeGreaterThanOrEqual(1);

    expect((await inject("DELETE", `/v1/admin/read-grants/${(rg.json() as { grantId: string }).grantId}`, adminToken)).statusCode).toBe(200);
    expect((await inject("DELETE", `/v1/admin/action-grants/${(ag.json() as { grantId: string }).grantId}`, adminToken)).statusCode).toBe(200);
    expect((await inject("DELETE", `/v1/admin/groups/${groupId}`, adminToken)).statusCode).toBe(200);
    expect((await inject("DELETE", `/v1/admin/subjects/${subjectId}`, adminToken)).statusCode).toBe(200);
  });
});
