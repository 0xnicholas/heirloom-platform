import { describe, expect, it } from "vitest";
import { objectType, prop, structType, link, action, queryFn, registry } from "../src/index.js";

describe("属性构建器（spec 10 §3 约束适配）", () => {
  it("链式修饰符落到 IR", () => {
    const p = prop.string().required().unique().length(1, 80).displayName("工号");
    expect(p.__ir).toMatchObject({
      type: "string",
      required: true,
      unique: true,
      length: { min: 1, max: 80 },
      displayName: "工号",
      status: "active",
    });
  });

  it("静态默认值与动态默认源文本", () => {
    const s = prop.string().default("x");
    expect(s.__ir.default).toEqual({ kind: "static", value: "x" });

    const d = prop
      .date()
      .default((ctx) => ctx.today);
    expect(d.__ir.default?.kind).toBe("dynamic");
    expect(String((d.__ir.default as { source: string }).source)).toContain("ctx.today");
  });

  it("range 归一（decimal 边界）", () => {
    const n = prop.decimal().range(0, "999999.99");
    expect(n.__ir.range).toEqual({ min: 0, max: "999999.99" });
  });

  it("enum 值集非空", () => {
    expect(() => prop.enum([])).toThrow(/不得为空/);
  });

  it("数组：元素约束收入 element，数组层 unique=集合语义、length=数组长度", () => {
    const a = prop
      .string()
      .length(1, 40)
      .array()
      .unique()
      .length(0, 10);
    expect(a.__ir.type).toBe("string[]");
    expect(a.__ir.array?.element).toMatchObject({ type: "string", length: { min: 1, max: 40 } });
    expect(a.__ir.array?.elementUnique).toBe(true);
    expect(a.__ir.array?.arrayLength).toEqual({ min: 0, max: 10 });
  });

  it("json 不得转数组", () => {
    expect(() => prop.json().array()).toThrow(/不得转为数组/);
  });

  it("regex 捕获 source/flags", () => {
    const r = prop.string().regex(/^[^@\s]+@[^@\s]+$/i);
    expect(r.__ir.regex).toEqual({ source: "^[^@\\s]+@[^@\\s]+$", flags: "i" });
  });
});

describe("registry（spec 60 §2.1）", () => {
  it("apiName 重复注册即拒", () => {
    objectType({ apiName: "dup-a", displayName: "A", properties: {} });
    expect(() => objectType({ apiName: "dup-a", displayName: "A2", properties: {} })).toThrow(/重复注册/);
  });

  it("action 与 function apiName 冲突即拒", () => {
    action({ apiName: "dup-callable", displayName: "A", params: {}, execute: () => ({}) });
    expect(() => queryFn({ apiName: "dup-callable", displayName: "F", params: {}, execute: () => ({}) })).toThrow(/冲突/);
  });
});

describe("链接标记（spec 10 §4）", () => {
  it("required 默认 false，thunk 延迟", () => {
    const l = link.manyToOne(() => registry.objectTypes.get("dup-a")!, { required: true });
    expect(l.__ir.cardinality).toBe("many-to-one");
    expect(l.__ir.required).toBe(true);
  });

  it("非 thunk 目标即拒", () => {
    expect(() => link.oneToMany({} as never)).toThrow(/thunk/);
  });
});

describe("structType", () => {
  it("登记并保序", () => {
    structType({
      apiName: "testAddr",
      displayName: "地址",
      properties: { street: prop.string().required(), city: prop.string().required() },
    });
    expect(registry.structs.get("testAddr")?.__propIRs.size).toBe(2);
  });
});
