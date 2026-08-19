import { describe, expect, it } from "vitest";
import { extractFreeIdentifiers, findDanglingIdentifiers } from "../src/free-identifiers.js";
import { validateDefinition } from "../src/validate.js";
import type { OntologyDefinition } from "../src/definition.js";

describe("自由标识符提取（spec 60 §7 联动校验基础）", () => {
  it("收集引用位标识符；成员属性与对象键不算", () => {
    const src = `(ctx, { employee, skillName }) => {
      const s = Employee.name;          // Employee 自由；name 属性不算
      const obj = { name: skillName };  // 对象键不算
      return ctx.all(Skill).find((s) => s.id === employee.id) ?? helper(s);
    }`;
    const free = extractFreeIdentifiers(src);
    expect(free.has("Employee")).toBe(true);
    expect(free.has("Skill")).toBe(true);
    expect(free.has("helper")).toBe(true);
    expect(free.has("ctx")).toBe(false);
    expect(free.has("employee")).toBe(false);
    expect(free.has("skillName")).toBe(false);
    expect(free.has("s")).toBe(false);
    expect(free.has("name")).toBe(false);
  });

  it("嵌套作用域遮蔽与解构", () => {
    const src = `(ctx, p) => {
      const { a, b: renamed } = p;
      function inner(a) { return Employee + a + b2; }
      return inner(renamed) + globalVar;
    }`;
    const free = extractFreeIdentifiers(src);
    expect(free.has("Employee")).toBe(true);
    expect(free.has("b2")).toBe(true);
    expect(free.has("globalVar")).toBe(true);
    expect(free.has("a")).toBe(false);
    expect(free.has("renamed")).toBe(false);
  });

  it("悬空判定：bindings 与全局白名单内不悬空", () => {
    const src = `(ctx) => Employee.filter((e) => Number(e.salary) > 0 && JSON.ok(e))`;
    const { dangling, free } = findDanglingIdentifiers(src, { Employee: {} });
    expect(dangling).toEqual([]);
    expect(free).toContain("Number");
    expect(free).toContain("JSON");
  });
});

describe("定义结构校验（spec 60 §7 先行拒绝）", () => {
  const base = (): OntologyDefinition => ({
    structs: [],
    objectTypes: [
      {
        apiName: "dept",
        displayName: "部门",
        status: "active",
        properties: [{ apiName: "name", displayName: "名称", type: "string", status: "active", required: true }],
        links: [],
      },
    ],
    actions: [],
    functions: [],
    bindings: {},
  });

  it("kebab/camel 命名规则", () => {
    const def = base();
    def.objectTypes[0]!.apiName = "BadName";
    const issues = validateDefinition(def);
    expect(issues.some((i) => i.path.includes("apiName") && /kebab/.test(i.message))).toBe(true);
  });

  it("同型双链接同名反向名 → 拒（spec 10 §4）", () => {
    const def = base();
    def.objectTypes[0]!.links = [
      { apiName: "a", displayName: "A", status: "active", cardinality: "many-to-many", target: "dept", reverse: "dept", required: false },
      { apiName: "b", displayName: "B", status: "active", cardinality: "many-to-many", target: "dept", reverse: "dept", required: false },
    ];
    const issues = validateDefinition(def);
    expect(issues.some((i) => /反向名 .*共用/.test(i.message))).toBe(true);
  });

  it("ref 出现在类型属性 → 拒（spec 10 §3.1）", () => {
    const def = base();
    def.objectTypes[0]!.properties.push({
      apiName: "owner", displayName: "Owner", type: "ref", status: "active", required: false, target: "dept",
    });
    const issues = validateDefinition(def);
    expect(issues.some((i) => /ref.*参数/.test(i.message))).toBe(true);
  });

  it("enum 属性 unique → 拒（约束适配表）", () => {
    const def = base();
    def.objectTypes[0]!.properties.push({
      apiName: "kind", displayName: "K", type: "enum", status: "active", required: false, values: ["a"], unique: true,
    });
    const issues = validateDefinition(def);
    expect(issues.some((i) => /enum.*unique/.test(i.message))).toBe(true);
  });

  it("struct 嵌套超两层 → 拒（spec 10 §2）", () => {
    const def = base();
    const mk = (n: string, ref?: string) => ({
      apiName: n,
      displayName: n,
      status: "active" as const,
      properties: ref
        ? [{ apiName: "inner", displayName: "I", type: "struct", status: "active" as const, required: false, struct: ref }]
        : [],
    });
    def.structs = [mk("s1", "s2"), mk("s2", "s3"), mk("s3")];
    def.objectTypes[0]!.properties.push({
      apiName: "a", displayName: "A", type: "struct", status: "active", required: false, struct: "s1",
    });
    const issues = validateDefinition(def);
    expect(issues.some((i) => /两层/.test(i.message))).toBe(true);
  });

  it("execute 源文本悬空引用 → 拒", () => {
    const def = base();
    def.actions.push({
      apiName: "do-thing",
      displayName: "Do",
      status: "active",
      params: {},
      executeSource: `(ctx) => NotExportedAnywhere(ctx.today)`,
    });
    const issues = validateDefinition(def);
    expect(issues.some((i) => /悬空引用.*NotExportedAnywhere/.test(i.message))).toBe(true);
  });

  it("execute 含 TS 注解 → 拒（须物化前剥除）", () => {
    const def = base();
    def.actions.push({
      apiName: "typed-thing",
      displayName: "T",
      status: "active",
      params: {},
      executeSource: `(ctx: ActionCtx): number => 1`,
    });
    const issues = validateDefinition(def);
    expect(issues.some((i) => /非合法 JS/.test(i.message))).toBe(true);
  });
});
