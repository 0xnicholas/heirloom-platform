import { describe, expect, it } from "vitest";
import * as fixture from "@heirloom/example-ontology";
import { action, materialize, registry, validateDefinition } from "../src/index.js";

/**
 * 冻结示例本体（spec 80 §示例本体）的物化 = M1 验收基准：
 * 5 对象类型 + 2 struct + 8 动作 + 2 函数；构造全覆盖。
 */

describe("materialize：冻结本体 → 定义 JSON（spec 60 §2.1）", () => {
  const def = materialize({ bindings: fixture });

  it("实体计数与 apiName", () => {
    expect(def.objectTypes.map((t) => t.apiName).sort()).toEqual(
      ["department", "employee", "membership", "project", "skill"].sort(),
    );
    expect(def.structs.map((s) => s.apiName).sort()).toEqual(["address", "money"].sort());
    expect(def.actions.map((a) => a.apiName).sort()).toEqual(
      [
        "adjust-salary",
        "assign-to-project",
        "create-department",
        "create-project",
        "grant-skill",
        "hire-employee",
        "offboard-employee",
        "transfer-employee",
      ].sort(),
    );
    expect(def.functions.map((f) => f.apiName).sort()).toEqual(["department-roster", "project-team"].sort());
  });

  it("employee：业务键 + decimal 字符串 range + 数组集合语义 + struct 嵌入", () => {
    const emp = def.objectTypes.find((t) => t.apiName === "employee")!;
    const byName = Object.fromEntries(emp.properties.map((p) => [p.apiName, p]));
    expect(byName.employeeNo).toMatchObject({ required: true, unique: true, type: "string" });
    expect(byName.salary).toMatchObject({ type: "decimal", range: { min: 0 } });
    expect(byName.certifications.type).toBe("string[]");
    expect(byName.certifications.array?.unique).toBe(true);
    expect(byName.address).toMatchObject({ type: "struct", struct: "address" });
    expect(byName.metadata.type).toBe("json");
    expect(byName.status).toMatchObject({
      type: "enum",
      values: ["active", "on-leave", "offboarded"],
      default: { kind: "static", value: "active" },
    });
  });

  it("链接：基数、反向名派生（原样不加复数）、required", () => {
    const emp = def.objectTypes.find((t) => t.apiName === "employee")!;
    const skills = emp.links.find((l) => l.apiName === "skills")!;
    expect(skills).toMatchObject({ cardinality: "many-to-many", target: "skill", reverse: "employee", required: false });

    const dept = def.objectTypes.find((t) => t.apiName === "department")!;
    expect(dept.links.find((l) => l.apiName === "employees")).toMatchObject({
      cardinality: "one-to-many",
      target: "employee",
      reverse: "department",
    });

    const mem = def.objectTypes.find((t) => t.apiName === "membership")!;
    expect(mem.links.find((l) => l.apiName === "employee")).toMatchObject({
      cardinality: "many-to-one",
      target: "employee",
      required: true,
    });
    expect(mem.links.find((l) => l.apiName === "project")!.reverse).toBe("memberships");
  });

  it("动作：ref 参数注入目标、动态默认源文本、execute 源文本", () => {
    const hire = def.actions.find((a) => a.apiName === "hire-employee")!;
    expect(hire.params.department).toMatchObject({ type: "ref", target: "department", required: true });
    expect(hire.params.hiredAt?.default?.kind).toBe("dynamic");
    expect(hire.params.hiredAt?.default).toMatchObject({
      kind: "dynamic",
      source: expect.stringContaining("ctx.today"),
    });
    expect(hire.executeSource).toMatch(/^(\(|async)/);
    expect(hire.executeSource).toContain("ValidationFailed");
  });

  it("绑定表：模块导出名 → 类型 apiName（execute 自由变量解析域）", () => {
    expect(def.bindings.Employee).toEqual({ kind: "object", apiName: "employee" });
    expect(def.bindings.Address).toEqual({ kind: "struct", apiName: "address" });
    expect(def.bindings.Membership).toEqual({ kind: "object", apiName: "membership" });
  });

  it("物化结果通过结构校验（validateDefinition 零 issue）", () => {
    expect(validateDefinition(def)).toEqual([]);
  });

  it("execute 内引用未导出标识符 → 物化即拒（预检）", () => {
    action({
      apiName: "bad-dangling-ref",
      displayName: "悬空",
      params: {},
      execute: () => helperNotExported(),
    });
    expect(() => materialize({ bindings: fixture })).toThrow(/未导出的标识符.*helperNotExported/);
    registry.actions.delete("bad-dangling-ref");
  });
});

function helperNotExported(): number {
  return 1;
}
