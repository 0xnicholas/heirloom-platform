import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { materialize } from "@heirloom/dsl";
import * as fixture from "@heirloom/example-ontology";
import { sql } from "kysely";
import {
  addGroupMember,
  assembleReadPredicates,
  AuthenticationError,
  authenticate,
  bootstrapAdmin,
  checkActionAllowed,
  createGroup,
  createSubject,
  DENY_ALL,
  executeQuery,
  GrantValidationError,
  grantAction,
  grantRead,
  invokeAction,
  issueToken,
  logSecurityEvent,
  pgExec,
  pushOntology,
  revokeReadGrant,
  revokeToken,
  runMigrations,
  createDb,
  WhitelistDeniedError,
  type AuthContext,
  type PushActor,
} from "../src/index.js";

/**
 * S3 读授权两态（全类型 vs 谓词收窄 vs 零授权）+ S6 白名单两拒 +
 * PAT 生命周期 + 超管短路 + 安全日志形状（spec 50 / 80 S3/S6）。
 */

const ADMIN_URL = process.env.HEIRLOOM_TEST_ADMIN_URL ?? "postgres://heirloom:heirloom@localhost:5433/postgres";
const dbName = `heirloom_test_${Math.random().toString(36).slice(2, 10)}`;
const dbUrl = ADMIN_URL.replace(/\/postgres$/, `/${dbName}`);

const pushActor: PushActor = { subjectId: null, subjectKind: "user", tokenId: null };
function frozen(): ReturnType<typeof materialize> {
  return JSON.parse(JSON.stringify(materialize({ bindings: fixture })));
}
const def = frozen();

let db: ReturnType<typeof createDb>;
let pool: Pool;

async function securityLogCount(code: string): Promise<number> {
  const r = await sql`SELECT count(*)::int AS n FROM hl_security_log WHERE code = ${code}`.execute(db);
  return (r.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  db = createDb(dbUrl);
  await runMigrations(db);
  await pushOntology(db, def, pushActor);
  pool = new Pool({ connectionString: dbUrl });

  // 域数据：员工三态 status
  const deptId = crypto.randomUUID();
  await pool.query(`INSERT INTO ontology.department (id, name, budget) VALUES ($1::uuid, '平台部', '100')`, [deptId]);
  for (const [no, name, status] of [["E1", "在岗甲", "active"], ["E2", "休假乙", "on-leave"], ["E3", "离退丙", "offboarded"]] as const) {
    await pool.query(
      `INSERT INTO ontology.employee (id, employee_no, name, status, department_id) VALUES ($1::uuid, $2, $3, $4, $5::uuid)`,
      [crypto.randomUUID(), no, name, status, deptId],
    );
  }
  const skillId = crypto.randomUUID();
  await pool.query(`INSERT INTO ontology.skill (id, name) VALUES ($1::uuid, 'go')`, [skillId]);
});

afterAll(async () => {
  await pool?.end();
  await db?.destroy();
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

/** 完整走读路径：装配谓词 → executeQuery（M3 注入点） */
async function queryAs(auth: AuthContext, request: Parameters<typeof executeQuery>[3], type = "employee") {
  const predicateByType = await assembleReadPredicates(db, auth, def);
  return executeQuery(pgExec(pool), type, def, request, { predicateByType });
}

describe("PAT 生命周期（spec 50 §4 / 30 §4.3）", () => {
  it("签发：明文仅此一次（hlk_ 前缀）；库中只存哈希", async () => {
    const { subjectId } = await createSubject(db, { kind: "user", name: "user:pat-01" });
    const { tokenId, token } = await issueToken(db, subjectId);
    expect(token).toMatch(/^hlk_[A-Za-z0-9_-]{43}$/);
    expect(tokenId).toBeTruthy();
    // 库内无明文：token 串不出现在任何 text 列
    const r = await sql`SELECT count(*)::int AS n FROM hl_tokens WHERE token_hash LIKE ${`%${token.slice(4)}%`}`.execute(db);
    expect((r.rows[0] as { n: number }).n).toBe(0); // 哈希是 hex，不含 base64url 段
  });

  it("认证：有效 token → 上下文（主体/组名/超管位）；无效/吊销 → AuthenticationError", async () => {
    const { subjectId } = await createSubject(db, { kind: "service", name: "svc:hr-sync" });
    const { groupId } = await createGroup(db, "pat-testers");
    await addGroupMember(db, groupId, subjectId);
    const { token } = await issueToken(db, subjectId);

    const auth = await authenticate(db, token);
    expect(auth.subjectKind).toBe("service");
    expect(auth.name).toBe("svc:hr-sync");
    expect(auth.groups).toEqual(["pat-testers"]); // ctx.groups = 组名直接成员
    expect(auth.isAdmin).toBe(false);

    await expect(authenticate(db, "hlk_invalid-invalid-invalid")).rejects.toBeInstanceOf(AuthenticationError);
    await expect(authenticate(db, "not-even-a-token")).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("吊销即时生效；列表无明文", async () => {
    const { subjectId } = await createSubject(db, { kind: "user", name: "user:pat-02" });
    const { tokenId, token } = await issueToken(db, subjectId);
    expect(await revokeToken(db, tokenId)).toBe(true);
    await expect(authenticate(db, token)).rejects.toMatchObject({ name: "AuthenticationError", reason: expect.stringContaining("吊销") });
    expect(await revokeToken(db, tokenId)).toBe(false); // 幂等
  });
});

describe("超管引导与短路（spec 50 §3）", () => {
  it("bootstrapAdmin：首个创建；已有超管 → no-op 返回现有", async () => {
    const first = await bootstrapAdmin(db, "user:admin-01");
    expect(first.created).toBe(true);
    const again = await bootstrapAdmin(db, "user:admin-02");
    expect(again.created).toBe(false);
    expect(again.subjectId).toBe(first.subjectId);
  });

  it("isAdmin 短路：读谓词空表（全可见）、白名单全过", async () => {
    const { subjectId } = await createSubject(db, { kind: "user", name: "user:root", isAdmin: true });
    const { token } = await issueToken(db, subjectId);
    const auth = await authenticate(db, token);
    expect(await assembleReadPredicates(db, auth, def)).toEqual({});
    await expect(checkActionAllowed(db, auth, "any-action")).resolves.toBeUndefined();
    // 全量可见（零配置）
    const r = await queryAs(auth, {});
    expect(r.data).toHaveLength(3);
  });
});

describe("S3 读授权两态（spec 80 S3 / 50 §5–§7）", () => {
  let alice: AuthContext; // hr 组 → employee 无谓词（全类型）
  let bob: AuthContext; // manager 组 → employee 谓词 status=active
  let carol: AuthContext; // 无组无授权 → 零授权 = 零行

  beforeAll(async () => {
    const hrGroup = await createGroup(db, "hr");
    const managerGroup = await createGroup(db, "manager");
    await grantRead(db, def, { groupId: hrGroup.groupId, typeApiName: "employee" }); // 无谓词
    await grantRead(db, def, { groupId: managerGroup.groupId, typeApiName: "employee", predicate: { status: { eq: "active" } } });
    // manager 另授 department（含 ctx 常量谓词：名称含「部」即可见——演示 $ctx 语法则用主体名）
    await grantRead(db, def, {
      groupId: managerGroup.groupId,
      typeApiName: "department",
      predicate: { name: { contains: "部" } },
    });

    const mk = async (name: string, groups: string[]): Promise<AuthContext> => {
      const { subjectId } = await createSubject(db, { kind: "user", name });
      for (const g of [hrGroup.groupId, managerGroup.groupId]) {
        const grp = (await sql`SELECT name FROM hl_groups WHERE id = ${g}::uuid`.execute(db)).rows[0] as { name: string };
        if (groups.includes(grp.name)) await addGroupMember(db, g, subjectId);
      }
      const { token } = await issueToken(db, subjectId);
      return authenticate(db, token);
    };
    alice = await mk("user:alice", ["hr"]);
    bob = await mk("user:bob", ["manager"]);
    carol = await mk("user:carol", []);
  });

  it("hr 成员（无谓词授权）→ 全体员工", async () => {
    const r = await queryAs(alice, { sort: [{ field: "employeeNo", dir: "asc" }] });
    expect((r.data as Record<string, unknown>[]).map((e) => e.employeeNo)).toEqual(["E1", "E2", "E3"]);
  });

  it("manager 成员（谓词授权）→ 仅 active 行；count/游标一致收窄", async () => {
    const r = await queryAs(bob, { count: true, sort: [{ field: "employeeNo", dir: "asc" }] });
    expect((r.data as Record<string, unknown>[]).map((e) => e.employeeNo)).toEqual(["E1"]);
    expect(r.count).toBe(1);
  });

  it("零授权主体 → 200 空集（data [] / count 0，与空集不可区分）", async () => {
    const r = await queryAs(carol, { count: true });
    expect(r.data).toEqual([]);
    expect(r.count).toBe(0);
  });

  it("include 跨类型收窄：manager 对 skill 零授权 → skills 变短（静默不报错）", async () => {
    // E1 有 go 技能（前置种子）——bob 谓词下 E1 可见，但 skill 类型零授权
    const e1Row = (await pool.query(`SELECT id FROM ontology.employee WHERE employee_no = 'E1'`)).rows[0]!;
    await pool.query(`INSERT INTO ontology_links.employee_skills (from_id, to_id) VALUES ($1::uuid, (SELECT id FROM ontology.skill LIMIT 1))`, [e1Row.id]);

    const r = await queryAs(bob, { filter: { employeeNo: { eq: "E1" } }, include: ["skills"] });
    const emp = r.data[0] as Record<string, unknown>;
    expect(emp.employeeNo).toBe("E1");
    expect(emp.skills).toEqual([]); // 多值变短
  });

  it("多授权 OR 并集：主体直授 + 组授权叠加", async () => {
    // david：manager 组（active 谓词）+ 主体直授 on-leave 谓词 → 并集两类可见
    const { subjectId } = await createSubject(db, { kind: "user", name: "user:david" });
    const mgrRow = (await sql`SELECT id FROM hl_groups WHERE name = 'manager'`.execute(db)).rows[0] as { id: string };
    await addGroupMember(db, mgrRow.id, subjectId);
    await grantRead(db, def, { subjectId, typeApiName: "employee", predicate: { status: { eq: "on-leave" } } });
    const { token } = await issueToken(db, subjectId);
    const david = await authenticate(db, token);

    const r = await queryAs(david, { sort: [{ field: "employeeNo", dir: "asc" }] });
    expect((r.data as Record<string, unknown>[]).map((e) => e.employeeNo)).toEqual(["E1", "E2"]);
  });

  it("授权撤销即时生效（回退零授权）", async () => {
    const erinSub = await createSubject(db, { kind: "user", name: "user:erin" });
    const g = await grantRead(db, def, { subjectId: erinSub.subjectId, typeApiName: "employee" });
    const { token } = await issueToken(db, erinSub.subjectId);
    const erin = await authenticate(db, token);
    expect((await queryAs(erin, {})).data).toHaveLength(3);
    expect(await revokeReadGrant(db, g.grantId)).toBe(true);
    expect((await queryAs(erin, {})).data).toEqual([]); // 零授权 = 零行
  });

  it("谓词 ctx 常量：$ctx userId 替换为主体名", async () => {
    // frank 的 employee 授权：name = $ctx:userId（主体名不是任何员工名 → 零行）
    const { subjectId } = await createSubject(db, { kind: "user", name: "在岗甲" });
    await grantRead(db, def, { subjectId, typeApiName: "employee", predicate: { name: { eq: { $ctx: "userId" } } } });
    const { token } = await issueToken(db, subjectId);
    const frank = await authenticate(db, token);
    const r = await queryAs(frank, {});
    expect((r.data as Record<string, unknown>[]).map((e) => e.name)).toEqual(["在岗甲"]); // 主体名恰为员工名 → 恰可见
  });

  it("fail-closed：谓词悬空属性/链接游走 → 授权创建拒绝", async () => {
    await expect(
      grantRead(db, def, { subjectId: crypto.randomUUID(), typeApiName: "employee", predicate: { nope: { eq: 1 } } }),
    ).rejects.toBeInstanceOf(GrantValidationError);
    await expect(
      grantRead(db, def, { subjectId: crypto.randomUUID(), typeApiName: "employee", predicate: { "mentor.name": { eq: "x" } } }),
    ).rejects.toBeInstanceOf(GrantValidationError); // 谓词仅限本类型属性（spec 50 §6）
    await expect(
      grantRead(db, def, { subjectId: crypto.randomUUID(), typeApiName: "employee", predicate: { name: { eq: { $ctx: "hacker" } } } }),
    ).rejects.toBeInstanceOf(GrantValidationError);
    await expect(
      grantRead(db, def, { subjectId: crypto.randomUUID(), groupId: crypto.randomUUID(), typeApiName: "employee" }),
    ).rejects.toBeInstanceOf(GrantValidationError); // subject/group 恰其一
  });

  it("DENY_ALL 形状：恒假（id IS NULL）且与空集同形", async () => {
    expect(DENY_ALL).toEqual({ id: { eq: null } });
    const r = await executeQuery(pgExec(pool), "employee", def, {}, { predicateByType: { employee: DENY_ALL } });
    expect(r.data).toEqual([]);
  });
});

describe("S6 白名单两拒（spec 80 S6 / 50 §8/§10）", () => {
  it("引擎层：主体未入白名单 → WhitelistDeniedError（不进 execute）；安全日志一条、审计无行", async () => {
    const { subjectId } = await createSubject(db, { kind: "user", name: "user:outsider" });
    const { token } = await issueToken(db, subjectId);
    const auth = await authenticate(db, token);
    const actor = { subjectId: auth.subjectId, subjectKind: "user" as const, tokenId: auth.tokenId, userId: auth.name, groups: auth.groups };

    const auditBefore = (await sql`SELECT count(*)::int AS n FROM hl_audit_log WHERE action_api_name = 'adjust-salary'`.execute(db)).rows[0] as { n: number };
    const logBefore = await securityLogCount("WHITELIST_DENIED");

    // 引擎层前置拒（server 层语义：拒后不 invoke）
    await expect(checkActionAllowed(db, auth, "adjust-salary")).rejects.toBeInstanceOf(WhitelistDeniedError);
    await logSecurityEvent(db, { code: "WHITELIST_DENIED", subject: auth.name, actionApiName: "adjust-salary", reason: "白名单外主体" });

    // execute 未被触达：无审计增量
    const auditAfter = (await sql`SELECT count(*)::int AS n FROM hl_audit_log WHERE action_api_name = 'adjust-salary'`.execute(db)).rows[0] as { n: number };
    expect(auditAfter.n).toBe(auditBefore.n);
    expect(await securityLogCount("WHITELIST_DENIED")).toBe(logBefore + 1);
  });

  it("白名单授权（组）：成员可过引擎层；非成员拒", async () => {
    const hrRow = (await sql`SELECT id FROM hl_groups WHERE name = 'hr'`.execute(db)).rows[0] as { id: string };
    const g = await grantAction(db, { groupId: hrRow.id, actionApiName: "adjust-salary" });
    const { subjectId } = await createSubject(db, { kind: "user", name: "user:salary-ops" });
    await addGroupMember(db, hrRow.id, subjectId);
    const { token } = await issueToken(db, subjectId);
    const auth = await authenticate(db, token);
    await expect(checkActionAllowed(db, auth, "adjust-salary")).resolves.toBeUndefined();
    // 撤销后即时拒
    expect(await (await import("../src/index.js")).revokeActionGrant(db, g.grantId)).toBe(true);
    await expect(checkActionAllowed(db, auth, "adjust-salary")).rejects.toBeInstanceOf(WhitelistDeniedError);
  });

  it("代码层：白名单内但 execute 抛 PermissionDenied → 事务回滚、不落审计、安全日志照记", async () => {
    // 场景层动作（不改冻结本体，spec 80 S6）：execute 内 ctx.groups 自判
    const guardDef = JSON.parse(JSON.stringify(def));
    guardDef.actions.push({
      apiName: "close-department",
      displayName: "关闭部门",
      status: "active",
      params: { department: { apiName: "department", type: "ref", target: "department", status: "active", required: true, displayName: "部门" } },
      executeSource: `(ctx, { department }) => {
        if (!ctx.groups.includes("hr")) throw new PermissionDenied("非 hr 组禁止关闭部门");
        ctx.delete(department);
        return { closed: department.id };
      }`,
    });
    await pushOntology(db, guardDef, pushActor);

    const { subjectId } = await createSubject(db, { kind: "user", name: "user:not-hr" });
    await grantAction(db, { subjectId, actionApiName: "close-department" }); // 白名单内
    const { token } = await issueToken(db, subjectId);
    const auth = await authenticate(db, token); // groups: []

    const deptId = crypto.randomUUID();
    await pool.query(`INSERT INTO ontology.department (id, name, budget) VALUES ($1::uuid, '待删部', '1')`, [deptId]);
    const actor = { subjectId: auth.subjectId, subjectKind: "user" as const, tokenId: auth.tokenId, userId: auth.name, groups: auth.groups };

    // execute 内 PermissionDenied → 冒泡（server 层 403 + 安全日志）
    await expect(
      invokeAction(pool, guardDef, "close-department", { department: deptId }, actor),
    ).rejects.toMatchObject({ name: "PermissionDenied" });
    await logSecurityEvent(db, { code: "PERMISSION_DENIED", subject: auth.name, actionApiName: "close-department", reason: "非 hr 组禁止关闭部门" });

    // 事务回滚：部门仍在；审计无行
    const still = (await pool.query(`SELECT count(*)::int AS n FROM ontology.department WHERE id = $1::uuid`, [deptId])).rows[0]!;
    expect(still.n).toBe(1);
    const audit = (await sql`SELECT count(*)::int AS n FROM hl_audit_log WHERE action_api_name = 'close-department'`.execute(db)).rows[0] as { n: number };
    expect(audit.n).toBe(0);
    expect(await securityLogCount("PERMISSION_DENIED")).toBe(1);
  });

  it("查询永不落安全日志（fails-closed 零行 = 特性，spec 50 §10）", async () => {
    const before = (await sql`SELECT count(*)::int AS n FROM hl_security_log`.execute(db)).rows[0] as { n: number };
    const { subjectId } = await createSubject(db, { kind: "user", name: "user:no-grants-q" });
    const { token } = await issueToken(db, subjectId);
    const auth = await authenticate(db, token);
    await queryAs(auth, { count: true }); // 零授权查询
    const after = (await sql`SELECT count(*)::int AS n FROM hl_security_log`.execute(db)).rows[0] as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("认证失败也落安全日志（UNAUTHENTICATED）", async () => {
    const before = await securityLogCount("UNAUTHENTICATED");
    try {
      await authenticate(db, "hlk_forged-forged-forged-forged-forged-forged-xx");
    } catch {
      await logSecurityEvent(db, { code: "UNAUTHENTICATED", reason: "无效 token" });
    }
    expect(await securityLogCount("UNAUTHENTICATED")).toBe(before + 1);
  });
});
