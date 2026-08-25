/**
 * S12 —— SDK 验收场景（spec 80 S12）：
 * 1) 类型直推：本体模块经幻影投影获得静态检查面（正例编译通过 + 反例 @ts-expect-error 拒绝）
 * 2) revision 对账：assertSynced 一致 → revision；漂移 → OntologyDriftError
 * 3) HTTP 冒烟：query/get/invoke 走真实 socket（app.listen + fetch）
 */
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { Pool } from "pg";
import { bootstrapAdmin, createDb, issueTokenWithValue, runMigrations } from "@heirloom/engine";
import { buildApp } from "@heirloom/server";
import * as ontology from "@heirloom/example-ontology";
import { createSdk, OntologyDriftError, type FilterNode, type Sdk, type SortSpec } from "../src/index.js";

const ADMIN_URL = process.env.HEIRLOOM_TEST_ADMIN_URL ?? "postgres://heirloom:heirloom@localhost:5433/postgres";
const dbName = `heirloom_test_sdk_${Math.random().toString(36).slice(2, 10)}`;
const dbUrl = ADMIN_URL.replace(/\/postgres$/, `/${dbName}`);
const BOOTSTRAP_TOKEN = "hlk_sdk_bootstrap_0123456789abcdef";

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let adminPool: Pool;
let sdk: Sdk<typeof ontology>;

async function pushDefinition(mutate?: (def: Record<string, any>) => void): Promise<void> {
  const { materialize } = await import("@heirloom/dsl");
  const def = JSON.parse(JSON.stringify(materialize({ bindings: ontology }))) as Record<string, any>;
  mutate?.(def);
  const res = await fetch(`${baseUrl}/v1/admin/ontology`, {
    method: "PUT",
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(def),
  });
  expect(res.ok).toBe(true);
}

beforeAll(async () => {
  adminPool = new Pool({ connectionString: ADMIN_URL });
  await adminPool.query(`CREATE DATABASE ${dbName}`);
  const db = createDb(dbUrl);
  await runMigrations(db);
  const boot = await bootstrapAdmin(db, "user:admin-01");
  await issueTokenWithValue(db, boot.subjectId!, BOOTSTRAP_TOKEN);
  await db.destroy();
  app = await buildApp({ databaseUrl: dbUrl });
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("未取得监听地址");
  baseUrl = `http://127.0.0.1:${address.port}`;
  sdk = createSdk({ url: baseUrl, token: BOOTSTRAP_TOKEN, ontology });
  await pushDefinition();
});

afterAll(async () => {
  await app?.close();
  await adminPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await adminPool?.end();
});

describe("S12.1 类型直推（编译期，@ts-expect-error 反例为证）", () => {
  it("filter 按属性类型封闭算子集", async () => {
    // 正例：enum eq、decimal 比较、数组 contains-any、一跳点路径
    const r = await sdk.objects.employee.query({
      filter: {
        and: [
          { status: { eq: "active" } },
          { salary: { gte: "100000" } },
          { certifications: { "contains-any": ["go", "rust"] } },
          { "mentor.name": { startsWith: "N" } },
        ],
      },
      sort: [{ field: "employeeNo", dir: "asc" }],
      count: true,
    });
    expect(r.data).toEqual([]);
    expect(r.count).toBe(0);

    // 反例：status 非法枚举成员（不调用——仅编译期拒绝）
    // @ts-expect-error 枚举成员外取值
    const negEnum = () => sdk.objects.employee.query({ filter: { status: { eq: "fired" } } });
    // 反例：decimal 无 contains（string 独享，spec 40 §6）
    // @ts-expect-error decimal 不支持 contains
    const negContains = () => sdk.objects.employee.query({ filter: { salary: { contains: "1" } } });
    // 反例：未知属性（直接标注断言——泛型 const 推断不触发多余属性检查）
    // @ts-expect-error 未知属性名
    const negUnknown: FilterNode<typeof ontology.Employee> = { titel: { eq: "x" } };
    // 反例：超过 3 个排序键（类型面拒绝；直接标注断言）
    // @ts-expect-error sort ≤3 键
    const negSort: SortSpec<typeof ontology.Employee> = [
      { field: "employeeNo", dir: "asc" }, { field: "name", dir: "asc" },
      { field: "status", dir: "asc" }, { field: "salary", dir: "asc" },
    ];
  });

  it("invoke 参数按 InputProps 校验；返回类型按 execute 返回值直推", async () => {
    const dept = await sdk.actions["create-department"].invoke({ name: "平台部", budget: "1200000" });
    expectTypeOf(dept.data).toEqualTypeOf<{ departmentId: string }>();

    // ref 参数 = UUID 字符串（execute 前注入完整对象是服务端语义）
    const deptId: string = dept.data.departmentId;
    const hire = await sdk.actions["hire-employee"].invoke({
      employeeNo: "E100",
      name: "张三",
      department: deptId, // required ref
    });
    expectTypeOf(hire.data).toEqualTypeOf<{ employeeId: string }>();
    expect(typeof hire.data.employeeId).toBe("string");

    // 反例：缺 required 参数
    // @ts-expect-error employeeNo 必填
    const negMissing = () => sdk.actions["hire-employee"].invoke({ name: "李四", department: deptId });
    // 反例：ref 位置传对象（应传 UUID）
    // @ts-expect-error ref 参数输入为 UUID 字符串
    const negRef = () => sdk.actions["hire-employee"].invoke({ employeeNo: "E101", name: "李四", department: { id: deptId } });

    // 动作结果可回流到后续调用（同事务引用的客户端版本）
    const roster = await sdk.functions["department-roster"].invoke({ department: deptId });
    expect(Array.isArray(roster.data)).toBe(true);
    expectTypeOf(roster.data).toEqualTypeOf<
      { id: string; employeeNo: string; name: string; status: "active" | "on-leave" | "offboarded" }[]
    >();
  });

  it("include 挂载按基数定型（1:N → 数组，1:1 → 对象|null）", async () => {
    const page = await sdk.objects.department.query({ include: ["employees", "employees.mentor"] });
    // @ts-expect-error 未声明的 include 路径
    const negInclude = () => sdk.objects.department.query({ include: ["memberships"] });
    expect(Array.isArray(page.data)).toBe(true);
    if (page.data[0]) {
      // 1:N → 数组；第二跳 mentor 为自链接 thunk `(): any`（TS 循环初始化硬限制）→ 弱类型
      type Emp = NonNullable<(typeof page.data)[number]["employees"]>[number];
      expectTypeOf<Emp>().toMatchObjectType<{ id: string }>();
    }
  });
});

describe("S12.2 revision 对账（期望态 ↔ 生效态）", () => {
  it("一致 → 返回 revision；漂移 → OntologyDriftError 带首差路径", async () => {
    const { revision } = await sdk.assertSynced();
    expect(revision).toBe(1);

    // 场景层演化：加可选属性 → revision 2 → 本地期望态落后 → 漂移
    await pushDefinition((def) => {
      def.objectTypes.find((t: { apiName: string }) => t.apiName === "employee").properties.push({
        apiName: "title", displayName: "职衔", status: "active", required: false, type: "string",
      });
    });
    const meta = await sdk.meta.ontology();
    expect(meta.revision).toBe(2);
    await expect(sdk.assertSynced()).rejects.toBeInstanceOf(OntologyDriftError);
    try {
      await sdk.assertSynced();
      expect.unreachable();
    } catch (err) {
      const e = err as OntologyDriftError;
      expect(e.serverRevision).toBe(2);
      expect(e.firstDivergence).toContain("title"); // 数组差异带新增元素 apiName
    }
  });
});

describe("S12.3 HTTP 冒烟（真实 socket）", () => {
  it("keyset 翻页 + get + If-Match 乐观锁 + get include", async () => {
    const dept = await sdk.actions["create-department"].invoke({ name: "工程部" });
    for (const no of ["E200", "E201", "E202"]) {
      await sdk.actions["hire-employee"].invoke({ employeeNo: no, name: `员工${no}`, department: dept.data.departmentId });
    }
    const p1 = await sdk.objects.employee.query({
      filter: { employeeNo: { in: ["E200", "E201", "E202"] } },
      sort: [{ field: "employeeNo", dir: "asc" }],
      limit: 2,
      count: true,
    });
    expect(p1.count).toBe(3);
    expect(p1.data).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    expectTypeOf(p1.data[0]!.employeeNo).toEqualTypeOf<string>();

    const p2 = await sdk.objects.employee.query({
      filter: { employeeNo: { in: ["E200", "E201", "E202"] } },
      sort: [{ field: "employeeNo", dir: "asc" }],
      limit: 2,
      cursor: p1.nextCursor,
    });
    expect(p2.data.map((e) => e.employeeNo)).not.toContain(p1.data[0]!.employeeNo);

    // department 为反向链接（employee 侧未声明）→ v1 弱类型：运行时可解析（引擎唯一反查），类型面不覆盖
    // @ts-expect-error 反向链接 include 路径 v1 不入类型面
    const getWithReverse = () => sdk.objects.employee.get(p1.data[0]!.id, { include: ["department"] });
    const one = await getWithReverse();
    // 反向链接运行时挂载验证
    expect((one.data as Record<string, unknown>)).toHaveProperty("department");

    const stale = "2000-01-01T00:00:00.000Z";
    await expect(sdk.objects.employee.get(p1.data[0]!.id, { ifMatch: stale })).rejects.toMatchObject({
      status: 409,
      code: "PRECONDITION_FAILED",
    });
  });

  it("调整薪资走动作 → 查询可见（读己之写的跨请求版本）", async () => {
    const emp = await sdk.objects.employee.query({
      filter: { employeeNo: { eq: "E200" } },
      include: ["mentor"],
    });
    const id = emp.data[0]!.id;
    await sdk.actions["adjust-salary"].invoke({ employee: id, newSalary: "640000", expectedUpdatedAt: emp.data[0]!.updatedAt });
    const after = await sdk.objects.employee.get(id);
    expect(after.data.salary).toBe("640000");
  });
});
