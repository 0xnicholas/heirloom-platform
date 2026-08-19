import { describe, expect, it } from "vitest";
import { materialize } from "@heirloom/dsl";
import * as fixture from "@heirloom/example-ontology";
import {
  compileQuery,
  QueryValidationError,
  UnknownTypeError,
  type CompiledQuery,
  type QueryRequest,
} from "../src/index.js";

/** 冻结本体定义（物化产物深拷贝） */
function def(): ReturnType<typeof materialize> {
  return JSON.parse(JSON.stringify(materialize({ bindings: fixture })));
}

function compile(request: QueryRequest, type = "employee", predicateByType?: Record<string, unknown>): CompiledQuery {
  return compileQuery(type, def(), request, predicateByType ? { predicateByType: predicateByType as never } : undefined);
}

function err(request: QueryRequest, type = "employee"): QueryValidationError {
  try {
    compile(request, type);
  } catch (e) {
    if (e instanceof QueryValidationError) return e;
    throw e;
  }
  throw new Error("期望 QueryValidationError");
}

describe("过滤编译：标量算子（spec 40 §6）", () => {
  it("eq + startsWith → 参数化条件", () => {
    const q = compile({ filter: { status: { eq: "active" }, name: { startsWith: "N" } } });
    expect(q.main.sql).toContain(`b."status" = $1`);
    expect(q.main.sql).toContain(`b."name" LIKE $2`);
    expect(q.main.params).toEqual(["active", "N%", 101]);
  });

  it("eq:null 即 null 检查；neq:null 反向", () => {
    const q = compile({ filter: { salary: { eq: null } } });
    expect(q.main.sql).toContain(`b."salary" IS NULL`);
    const q2 = compile({ filter: { salary: { neq: null } } });
    expect(q2.main.sql).toContain(`b."salary" IS NOT NULL`);
  });

  it("neq 用 IS DISTINCT FROM（NULL 语义安全）", () => {
    const q = compile({ filter: { status: { neq: "active" } } });
    expect(q.main.sql).toContain(`b."status" IS DISTINCT FROM $1`);
  });

  it("and/or/not 任意嵌套", () => {
    const q = compile({
      filter: { and: [{ status: { eq: "active" } }, { or: [{ name: { contains: "李" } }, { not: { employeeNo: { startsWith: "T" } } }] }] },
    });
    expect(q.main.sql).toContain(`(b."status" = $1 AND (b."name" LIKE $2 OR NOT (b."employee_no" LIKE $3)))`);
    expect(q.main.params).toEqual(["active", "%李%", "T%", 101]);
  });

  it("decimal 全链路字符串 → $n::numeric 精确比较", () => {
    const q = compile({ filter: { salary: { gt: "950000" } } });
    expect(q.main.sql).toContain(`b."salary" > $1::numeric`);
    expect(q.main.params).toEqual(["950000", 101]);
  });

  it("in → = ANY(数组)；空数组恒 FALSE", () => {
    const q = compile({ filter: { status: { in: ["active", "on-leave"] } } });
    expect(q.main.sql).toContain(`b."status" = ANY($1)`);
    expect(q.main.params).toEqual([["active", "on-leave"], 101]);
    const q2 = compile({ filter: { or: [{ status: { in: [] } }, { status: { eq: "active" } }] } });
    expect(q2.main.sql).toContain(`FALSE`);
  });

  it("contains-any → 数组重叠 &&", () => {
    const q = compile({ filter: { certifications: { "contains-any": ["go", "rust"] } } });
    expect(q.main.sql).toContain(`b."certifications" && $1`);
    expect(q.main.params).toEqual([["go", "rust"], 101]);
  });

  it("LIKE 通配符转义（%_\\）；大小写敏感", () => {
    const q = compile({ filter: { name: { contains: "50%_a\\b" } } });
    expect(q.main.params).toEqual([`%50\\%\\_a\\\\b%`, 101]);
  });

  it("系统字段 id/createdAt/updatedAt 可过滤", () => {
    const q = compile({ filter: { createdAt: { gt: "2026-01-01T00:00:00Z" }, id: { eq: "018f2a55-aaaa-7bbb-8ccc-dddd00000001" } } });
    expect(q.main.sql).toContain(`b."created_at" > $1::timestamptz`);
    expect(q.main.sql).toContain(`b."id" = $2::uuid`);
  });
});

describe("过滤编译：一跳链接属性（EXISTS 下推，spec 40 §6）", () => {
  it("many-to-one/one-to-one 正向（本表 FK）: mentor.name", () => {
    const q = compile({ filter: { "mentor.name": { startsWith: "N" } } });
    expect(q.main.sql).toContain(
      `EXISTS (SELECT 1 FROM "ontology"."employee" s2 WHERE s2."id" = b."mentor_id" AND s2."name" LIKE $1)`,
    );
  });

  it("one-to-many 正向（对方 FK）: employees.status（department 查询）", () => {
    const q = compile({ filter: { "employees.status": { eq: "active" } } }, "department");
    expect(q.main.sql).toContain(
      `EXISTS (SELECT 1 FROM "ontology"."employee" s2 WHERE s2."department_id" = b."id" AND s2."status" = $1)`,
    );
  });

  it("many-to-many 正向（链接表）: skills.name", () => {
    const q = compile({ filter: { "skills.name": { eq: "go" } } });
    expect(q.main.sql).toContain(`FROM "ontology_links"."employee_skills" lt JOIN "ontology"."skill" s2 ON s2."id" = lt."to_id"`);
    expect(q.main.sql).toContain(`lt."from_id" = b."id"`);
    expect(q.main.sql).toContain(`s2."name" = $1`);
  });

  it("反向遍历（反向名）: mentee.name（1:1 反向=对方 UNIQUE FK）", () => {
    const q = compile({ filter: { "mentee.name": { contains: "李" } } });
    expect(q.main.sql).toContain(`EXISTS (SELECT 1 FROM "ontology"."employee" s2 WHERE s2."mentor_id" = b."id" AND s2."name" LIKE $1)`);
  });

  it("反向遍历: memberships.role（many-to-one 反向=对方非唯一 FK，多值）", () => {
    const q = compile({ filter: { "memberships.role": { eq: "lead" } } });
    expect(q.main.sql).toContain(`EXISTS (SELECT 1 FROM "ontology"."membership" s2 WHERE s2."employee_id" = b."id" AND s2."role" = $1)`);
  });

  it("反向遍历: department.name（one-to-many 反向=本表 FK，单值）", () => {
    const q = compile({ filter: { "department.name": { contains: "平台" } } });
    expect(q.main.sql).toContain(`EXISTS (SELECT 1 FROM "ontology"."department" s2 WHERE s2."id" = b."department_id" AND s2."name" LIKE $1)`);
  });

  it("一跳目标类型的行级谓词注入 EXISTS（spec 40 §9）", () => {
    const q = compile(
      { filter: { "employees.status": { eq: "on-leave" } } },
      "department",
      { employee: { status: { eq: "active" } } },
    );
    expect(q.main.sql).toContain(`s2."status" = $1 AND s2."status" = $2`);
  });
});

describe("行级谓词注入（主查询/count 一致，spec 40 §9 / 50 §7）", () => {
  it("谓词 AND 进主查询与 count", () => {
    const q = compile({ filter: { name: { contains: "李" } }, count: true }, "employee", {
      employee: { status: { eq: "active" } },
    });
    expect(q.main.sql).toContain(`b."name" LIKE $1 AND b."status" = $2`);
    expect(q.count!.sql).toContain(`b."name" LIKE $1 AND b."status" = $2`);
    expect(q.count!.params).toEqual(["%李%", "active"]);
  });
});

describe("排序与 keyset 游标（spec 40 §6）", () => {
  it("≤3 键 + id 隐式末位；null 序锁定 PG 默认", () => {
    const q = compile({ sort: [{ field: "name", dir: "asc" }, { field: "salary", dir: "desc" }] });
    expect(q.main.sql).toContain(`ORDER BY b."name" ASC NULLS LAST, b."salary" DESC NULLS FIRST, b."id" ASC NULLS LAST`);
  });

  it("用户末位显式 id 不重复", () => {
    const q = compile({ sort: [{ field: "name", dir: "asc" }, { field: "id", dir: "desc" }] });
    expect(q.main.sql).toContain(`ORDER BY b."name" ASC NULLS LAST, b."id" DESC NULLS FIRST LIMIT`);
  });

  it("keyset 锥：ASC 非空游标值", () => {
    const first = compile({ sort: [{ field: "name", dir: "asc" }], limit: 1 });
    const cursor = b64({ s: sig([["name", "asc"], ["id", "asc"]]), k: ["李四"], id: "018f2a55-aaaa-7bbb-8ccc-dddd00000001" });
    const second = compile({ sort: [{ field: "name", dir: "asc" }], cursor });
    expect(first.main.sql).toContain(`LIMIT $1`);
    expect(second.main.sql).toContain(
      `((b."name" > $1 OR b."name" IS NULL) OR (b."name" IS NOT DISTINCT FROM $1 AND b."id" > $2::uuid))`,
    );
    expect(second.main.params).toEqual(["李四", "018f2a55-aaaa-7bbb-8ccc-dddd00000001", 101]);
  });

  it("keyset 锥：DESC NULL 游标值 → 非空皆在其后", () => {
    const cursor = b64({ s: sig([["salary", "desc"], ["id", "asc"]]), k: [null], id: "018f2a55-aaaa-7bbb-8ccc-dddd00000001" });
    const q = compile({ sort: [{ field: "salary", dir: "desc" }], cursor });
    expect(q.main.sql).toContain(`(b."salary" IS NOT NULL OR (b."salary" IS NULL AND b."id" > $1::uuid))`);
  });

  it("keyset 锥：ASC NULL 游标值 → 仅 NULL 平键后比 id", () => {
    const cursor = b64({ s: sig([["salary", "asc"], ["id", "asc"]]), k: [null], id: "018f2a55-aaaa-7bbb-8ccc-dddd00000001" });
    const q = compile({ sort: [{ field: "salary", dir: "asc" }], cursor });
    expect(q.main.sql).toContain(`WHERE (b."salary" IS NULL AND b."id" > $1::uuid)`);
  });

  it("游标签名不匹配（换排序）→ 422", () => {
    const cursor = b64({ s: sig([["salary", "desc"], ["id", "asc"]]), k: [null], id: "018f2a55-aaaa-7bbb-8ccc-dddd00000001" });
    const e = err({ sort: [{ field: "name", dir: "asc" }], cursor });
    expect(e.issues[0]!.path).toBe("cursor");
  });

  it("游标不可解析 → 422；载荷形状非法 → 422", () => {
    expect(err({ cursor: "!!!not-base64!!!" }).issues[0]!.path).toBe("cursor");
    const bad = b64({ s: sig([["name", "asc"], ["id", "asc"]]), k: ["x"], id: "not-a-uuid" });
    expect(err({ cursor: bad }).issues[0]!.path).toBe("cursor");
  });
});

describe("include 编译（spec 30 §3.1 / 50 §7）", () => {
  it("多值跳（对方 FK）: department include employees", () => {
    const q = compile({ include: ["employees"] }, "department");
    const hop = q.includes[0]!;
    expect(hop.multiple).toBe(true);
    expect(hop.targetType).toBe("employee");
    expect(hop.statement.sql).toBe(
      `SELECT s."department_id" AS __parent_id, s.* FROM "ontology"."employee" s WHERE s."department_id" = ANY($1::uuid[]) ORDER BY __parent_id, s."id"`,
    );
  });

  it("单值跳（本表 FK）: employee include mentor —— LEFT JOIN 保父行", () => {
    const q = compile({ include: ["mentor"] });
    const hop = q.includes[0]!;
    expect(hop.multiple).toBe(false);
    expect(hop.statement.sql).toContain(`FROM "ontology"."employee" p LEFT JOIN "ontology"."employee" s ON s."id" = p."mentor_id"`);
    expect(hop.statement.sql).toContain(`WHERE p."id" = ANY($1::uuid[])`);
  });

  it("M:N 跳: employee include skills —— 链接表 JOIN", () => {
    const q = compile({ include: ["skills"] });
    const hop = q.includes[0]!;
    expect(hop.multiple).toBe(true);
    expect(hop.statement.sql).toContain(
      `FROM "ontology_links"."employee_skills" lt JOIN "ontology"."skill" s ON s."id" = lt."to_id" WHERE lt."from_id" = ANY($1::uuid[])`,
    );
  });

  it("两跳链: department include employees.mentor", () => {
    const q = compile({ include: ["employees.mentor"] }, "department");
    expect(q.includes).toHaveLength(2);
    const [h1, h2] = q.includes;
    expect(h1.hop).toBe(0);
    expect(h1.targetType).toBe("employee");
    expect(h2.hop).toBe(1);
    expect(h2.parentType).toBe("employee");
    expect(h2.targetType).toBe("employee");
    expect(h2.multiple).toBe(false);
  });

  it("include 各跳行级谓词：单值进 ON、多值进 WHERE", () => {
    const q = compile({ include: ["mentor", "skills"] }, "employee", {
      employee: { status: { eq: "active" } },
    });
    const [mentor, skills] = q.includes;
    expect(mentor.statement.sql).toContain(`ON s."id" = p."mentor_id" AND s."status" = $2`);
    expect(mentor.statement.params).toEqual(["active"]);
    // skills 跳无谓词（skill 类型未配）→ 仅锚定条件
    expect(skills.statement.sql).toContain(`WHERE lt."from_id" = ANY($1::uuid[])`);
    expect(skills.statement.sql).not.toContain(` AND s.`);
    expect(skills.statement.params).toEqual([]);
  });

  it("include 深于 2 跳 → 422", () => {
    const e = err({ include: ["employees.mentor.mentee"] }, "department");
    expect(e.issues[0]!.message).toContain("2 跳");
  });
});

describe("校验拒绝（→ 422 VALIDATION_FAILED，spec 30 §6）", () => {
  it("未知算子 / 未知属性 / 两跳以上点路径", () => {
    expect(err({ filter: { name: { fuzz: "x" } } }).issues[0]!.message).toContain("未知算子");
    expect(err({ filter: { nope: { eq: "x" } } }).issues[0]!.message).toContain("未知属性");
    expect(err({ filter: { "mentor.mentor.name": { eq: "x" } } }).issues[0]!.message).toContain("一跳");
  });

  it("链接名裸用 → 提示点路径", () => {
    expect(err({ filter: { mentor: { eq: null } } }).issues[0]!.message).toContain("点路径");
  });

  it("limit 边界：0 / 1001 / 非整数 → 422；默认 100", () => {
    expect(err({ limit: 0 }).issues[0]!.path).toBe("limit");
    expect(err({ limit: 1001 }).issues[0]!.message).toContain("1000");
    expect(err({ limit: 1.5 }).issues[0]!.path).toBe("limit");
    expect(compile({}).main.sql).toContain("LIMIT $1");
    expect(compile({}).main.params).toEqual([101]);
  });

  it("排序越限：>3 键 / 链接属性 / 数组属性 / 未知字段 / 非法 dir", () => {
    expect(err({ sort: [
      { field: "name", dir: "asc" }, { field: "salary", dir: "asc" }, { field: "status", dir: "asc" }, { field: "hiredAt", dir: "asc" },
    ] }).issues[0]!.message).toContain("3");
    expect(err({ sort: [{ field: "mentor", dir: "asc" }] }).issues[0]!.message).toContain("标量属性");
    expect(err({ sort: [{ field: "certifications", dir: "asc" }] }).issues[0]!.message).toContain("不可排序");
    expect(err({ sort: [{ field: "nope", dir: "asc" }] }).issues[0]!.message).toContain("排序字段");
    expect(err({ sort: [{ field: "name", dir: "ascending" }] }).issues[0]!.message).toContain("asc/desc");
  });

  it("值类型校验：datetime 缺时区 / decimal 传数字 / 枚举成员外 / in 含 null / contains 用于整数", () => {
    expect(err({ filter: { createdAt: { gt: "2026-01-01T00:00:00" } } }).issues[0]!.message).toContain("ISO 8601");
    expect(err({ filter: { salary: { gt: 950000 } } }).issues[0]!.message).toContain("字符串");
    expect(err({ filter: { status: { eq: "fired" } } }).issues[0]!.message).toContain("枚举");
    expect(err({ filter: { status: { in: ["active", null] } } }).issues[0]!.message).toContain("null");
    expect(err({ filter: { salary: { contains: "95" } } }).issues[0]!.message).toContain("string");
  });

  it("类型不存在 → UnknownTypeError（Fastify 层映射 404）", () => {
    expect(() => compile({}, "no-such-type")).toThrow(UnknownTypeError);
  });
});

describe("count 编译（spec 30 §3.1）", () => {
  it("count 省缺 false；true 才产出", () => {
    expect(compile({}).count).toBeNull();
    const q = compile({ count: true, filter: { status: { eq: "active" } } });
    expect(q.count!.sql).toBe(`SELECT count(*)::int AS n FROM "ontology"."employee" b WHERE b."status" = $1`);
    expect(q.count!.params).toEqual(["active"]);
  });
});

// ── 游标编码助手（与实现同构：base64url(JSON{s,k,id})）──

function b64(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function sig(sort: [string, string][]): string {
  return JSON.stringify({ sort, type: "employee" });
}
