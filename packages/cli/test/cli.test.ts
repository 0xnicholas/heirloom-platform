import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseCsv } from "../src/csv.js";
import { buildDefinition } from "../src/apply.js";

describe("parseCsv（RFC4180 子集）", () => {
  it("基本分隔/换行/空串", () => {
    expect(parseCsv("a,b,c\n1,,3\n")).toEqual([["a", "b", "c"], ["1", "", "3"]]);
  });

  it("引号包裹：逗号/换行/双引号转义", () => {
    expect(parseCsv('name,note\n"x,y","line1\nline2""q"""\n')).toEqual([
      ["name", "note"],
      ["x,y", 'line1\nline2"q"'],
    ]);
  });

  it("CRLF 与尾行无换行", () => {
    expect(parseCsv("a,b\r\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("buildDefinition（esbuild 求值本体 → 物化定义）", () => {
  it("冻结示例本体 TS → 定义 JSON（execute 源文本已剥 TS、bindings 齐）", async () => {
    const def = (await buildDefinition(path.resolve(import.meta.dirname, "../../example-ontology/ontology.ts"))) as {
      objectTypes: { apiName: string }[];
      actions: { apiName: string; executeSource: string }[];
      functions: { apiName: string }[];
      bindings: Record<string, unknown>;
    };
    expect(def.objectTypes.map((t) => t.apiName)).toEqual(
      expect.arrayContaining(["department", "employee", "skill", "project", "membership"]),
    );
    expect(def.actions.map((a) => a.apiName)).toEqual(
      expect.arrayContaining(["hire-employee", "grant-skill", "transfer-employee", "adjust-salary", "offboard-employee"]),
    );
    expect(def.functions.map((f) => f.apiName)).toEqual(expect.arrayContaining(["department-roster", "project-team"]));
    // execute 纯 JS（无 TS 注解残留）
    for (const a of def.actions) {
      expect(a.executeSource).not.toMatch(/:\s*(string|number|boolean)\b/);
    }
    // 绑定表 = 模块导出（Employee/Department/Skill/…）
    expect(Object.keys(def.bindings)).toEqual(expect.arrayContaining(["Employee", "Department", "Skill", "Project", "Membership"]));
  });
});
