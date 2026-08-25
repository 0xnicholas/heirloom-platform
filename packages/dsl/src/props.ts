/**
 * 属性构建器 —— 链式修饰符（spec 10 §6 外形八项之一）。
 *
 * 类型推断走幻影类型参数（值类型 T × required R × 默认值 D × 注入类型 I 四轴），
 * 运行时零开销：幻影字段一律 `declare`（不发射）。
 *
 * decimal 全链路 JSON 字符串编码（spec 10 §3）；属性默认可选、required 显式声明。
 */
import type { DefaultSpec, Status } from "./definition.js";
import type { Obj, ObjectTypeMarker } from "./object.js";
import type { StructMarker, StructShape } from "./struct.js";

/**
 * 幻影轴接口：值类型 T × required R × 默认值 D × 注入类型 I 四轴（spec 10 §6 外形一）。
 * 字符串键（declare 仅类型层，不发射）——避免跨模块 unique symbol 不同一。
 */
export interface PhantomAxes<T, R extends boolean, D extends boolean, I> {
  readonly __valueT?: T;
  readonly __reqT?: R;
  readonly __defT?: D;
  readonly __injT?: I;
}

/** 动态默认值 ctx：与动作 ctx 的判定依据同源（spec 20 §3） */
export interface DefaultCtx {
  readonly userId: string;
  readonly groups: readonly string[];
  readonly today: string;
  readonly now: string;
}

/** 构建器内部运行时形态（物化前的中间表示） */
export interface PropIR {
  apiName: string;
  displayName?: string;
  description?: string;
  status: Status;
  type: string;
  required: boolean;
  unique?: boolean;
  values?: string[];
  structApiName?: string;
  targetRef?: () => unknown;
  length?: { min?: number; max?: number };
  range?: { min?: number | string; max?: number | string };
  regex?: { source: string; flags?: string };
  default?: DefaultSpec;
  array?: {
    elementUnique?: boolean;
    arrayLength?: { min?: number; max?: number };
    // 元素约束（在 .array() 之前链在元素构建器上）
    element: {
      type: string;
      values?: string[];
      structApiName?: string;
      length?: { min?: number; max?: number };
      range?: { min?: number | string; max?: number | string };
      regex?: { source: string; flags?: string };
    };
  };
}

/** 元数据修饰（全部构建器共用） */
export interface MetaModifiers<T, R extends boolean, D extends boolean, I, Self> {
  displayName(name: string): Self;
  description(text: string): Self;
  status(status: Status): Self;
}

/* ────────────────────────── 基类（运行时逻辑，无类型面） ────────────────────────── */

export abstract class PropIRHolder {
  constructor(public readonly __ir: PropIR) {}
}

function clone<T extends PropIRHolder>(b: T, mutate: (ir: PropIR) => void): T {
  const copy = { ...b.__ir };
  mutate(copy);
  return Object.assign(Object.create(Object.getPrototypeOf(b)), b, { __ir: copy });
}

function setDefault(ir: PropIR, value: unknown): void {
  if (typeof value === "function") {
    ir.default = { kind: "dynamic", source: String(value) };
  } else {
    if (value !== null && typeof value === "object") {
      throw new Error("静态默认值必须为字面量（string/number/boolean/null）");
    }
    ir.default = { kind: "static", value: value as string | number | boolean | null };
  }
}

/* ────────────────────────── 标量构建器族 ────────────────────────── */

/** string：length / regex / unique / array */
export class StringProp<R extends boolean = false, D extends boolean = false>
  extends PropIRHolder
  implements PhantomAxes<string, R, D, string>
{
  declare readonly __valueT: string;
  declare readonly __reqT: R;
  declare readonly __defT: D;
  declare readonly __injT: string;

  required(): StringProp<true, D> {
    return clone(this, (ir) => { ir.required = true; }) as unknown as StringProp<true, D>;
  }
  default(value: string | ((ctx: DefaultCtx) => string)): StringProp<true, true> {
    return clone(this, (ir) => setDefault(ir, value)) as unknown as StringProp<true, true>;
  }
  unique(): StringProp<R, D> {
    return clone(this, (ir) => { ir.unique = true; });
  }
  length(min: number, max?: number): StringProp<R, D> {
    return clone(this, (ir) => { ir.length = { min, max }; });
  }
  regex(re: RegExp): StringProp<R, D> {
    return clone(this, (ir) => { ir.regex = { source: re.source, flags: re.flags }; });
  }
  array(): StringArrayProp<R, D> {
    return toArrayProp(this) as unknown as StringArrayProp<R, D>;
  }
  displayName(name: string): StringProp<R, D> {
    return clone(this, (ir) => { ir.displayName = name; });
  }
  description(text: string): StringProp<R, D> {
    return clone(this, (ir) => { ir.description = text; });
  }
  status(status: Status): StringProp<R, D> {
    return clone(this, (ir) => { ir.status = status; });
  }
}

/** integer / float / decimal：range / unique / array（integer/float 值域 = number；decimal = JSON 字符串编码） */
export class NumberProp<T, R extends boolean = false, D extends boolean = false>
  extends PropIRHolder
  implements PhantomAxes<T, R, D, T>
{
  declare readonly __valueT: T;
  declare readonly __reqT: R;
  declare readonly __defT: D;
  declare readonly __injT: T;

  required(): NumberProp<T, true, D> {
    return clone(this, (ir) => { ir.required = true; }) as unknown as NumberProp<T, true, D>;
  }
  default(value: T | ((ctx: DefaultCtx) => T)): NumberProp<T, true, true> {
    return clone(this, (ir) => setDefault(ir, value)) as unknown as NumberProp<T, true, true>;
  }
  unique(): NumberProp<T, R, D> {
    return clone(this, (ir) => { ir.unique = true; });
  }
  range(min: number | string, max?: number | string): NumberProp<T, R, D> {
    return clone(this, (ir) => { ir.range = normalizeRange(ir.type, min, max); });
  }
  array(): NumberArrayProp<T, R, D> {
    return toArrayProp(this) as unknown as NumberArrayProp<T, R, D>;
  }
  displayName(name: string): NumberProp<T, R, D> {
    return clone(this, (ir) => { ir.displayName = name; });
  }
  description(text: string): NumberProp<T, R, D> {
    return clone(this, (ir) => { ir.description = text; });
  }
  status(status: Status): NumberProp<T, R, D> {
    return clone(this, (ir) => { ir.status = status; });
  }
}

/** enum：default / required / array */
export class EnumProp<V extends string, R extends boolean = false, D extends boolean = false>
  extends PropIRHolder
  implements PhantomAxes<V, R, D, V>
{
  declare readonly __valueT: V;
  declare readonly __reqT: R;
  declare readonly __defT: D;
  declare readonly __injT: V;

  required(): EnumProp<V, true, D> {
    return clone(this, (ir) => { ir.required = true; }) as unknown as EnumProp<V, true, D>;
  }
  default(value: V | ((ctx: DefaultCtx) => V)): EnumProp<V, true, true> {
    return clone(this, (ir) => setDefault(ir, value)) as unknown as EnumProp<V, true, true>;
  }
  array(): EnumArrayProp<V, R, D> {
    return toArrayProp(this) as unknown as EnumArrayProp<V, R, D>;
  }
  displayName(name: string): EnumProp<V, R, D> {
    return clone(this, (ir) => { ir.displayName = name; });
  }
  description(text: string): EnumProp<V, R, D> {
    return clone(this, (ir) => { ir.description = text; });
  }
  status(status: Status): EnumProp<V, R, D> {
    return clone(this, (ir) => { ir.status = status; });
  }
}

/** boolean / date / datetime / json：裸修饰 */
export class PlainProp<T, R extends boolean = false, D extends boolean = false>
  extends PropIRHolder
  implements PhantomAxes<T, R, D, T>
{
  declare readonly __valueT: T;
  declare readonly __reqT: R;
  declare readonly __defT: D;
  declare readonly __injT: T;

  required(): PlainProp<T, true, D> {
    return clone(this, (ir) => { ir.required = true; }) as unknown as PlainProp<T, true, D>;
  }
  default(value: T | ((ctx: DefaultCtx) => T)): PlainProp<T, true, true> {
    return clone(this, (ir) => setDefault(ir, value)) as unknown as PlainProp<T, true, true>;
  }
  array(): PlainArrayProp<T, R, D> {
    return toArrayProp(this) as unknown as PlainArrayProp<T, R, D>;
  }
  displayName(name: string): PlainProp<T, R, D> {
    return clone(this, (ir) => { ir.displayName = name; });
  }
  description(text: string): PlainProp<T, R, D> {
    return clone(this, (ir) => { ir.description = text; });
  }
  status(status: Status): PlainProp<T, R, D> {
    return clone(this, (ir) => { ir.status = status; });
  }
}

/* ────────────────────────── struct / ref ────────────────────────── */

/** struct：嵌入值形状（无身份、不参与链接——spec 10 §2） */
export class StructProp<S, R extends boolean = false, D extends boolean = false>
  extends PropIRHolder
  implements PhantomAxes<S, R, D, S>
{
  declare readonly __valueT: S;
  declare readonly __reqT: R;
  declare readonly __defT: D;
  declare readonly __injT: S;

  required(): StructProp<S, true, D> {
    return clone(this, (ir) => { ir.required = true; }) as unknown as StructProp<S, true, D>;
  }
  default(value: S | ((ctx: DefaultCtx) => S)): StructProp<S, true, true> {
    return clone(this, (ir) => setDefault(ir, value)) as unknown as StructProp<S, true, true>;
  }
  array(): StructArrayProp<S, R, D> {
    return toArrayProp(this) as unknown as StructArrayProp<S, R, D>;
  }
  displayName(name: string): StructProp<S, R, D> {
    return clone(this, (ir) => { ir.displayName = name; });
  }
  description(text: string): StructProp<S, R, D> {
    return clone(this, (ir) => { ir.description = text; });
  }
  status(status: Status): StructProp<S, R, D> {
    return clone(this, (ir) => { ir.status = status; });
  }
}

/** 对象引用参数：输入为 UUID，execute 前注入完整对象（spec 10 §6 外形八项之八） */
export class RefProp<T extends ObjectTypeMarker<any, any>, R extends boolean = false>
  extends PropIRHolder
  implements PhantomAxes<string, R, false, Obj<T>>
{
  declare readonly __valueT: string;
  declare readonly __reqT: R;
  declare readonly __defT: false;
  declare readonly __injT: Obj<T>;

  required(): RefProp<T, true> {
    return clone(this, (ir) => { ir.required = true; }) as unknown as RefProp<T, true>;
  }
  displayName(name: string): RefProp<T, R> {
    return clone(this, (ir) => { ir.displayName = name; });
  }
  description(text: string): RefProp<T, R> {
    return clone(this, (ir) => { ir.description = text; });
  }
  status(status: Status): RefProp<T, R> {
    return clone(this, (ir) => { ir.status = status; });
  }
}

/* ────────────────────────── 数组构建器 ────────────────────────── */

/** 数组：默认保序允许重复；.unique() = 集合语义（保序去重）；.length() 作用于数组长度 */
export class ArrayProp<E, R extends boolean = false, D extends boolean = false>
  extends PropIRHolder
  implements PhantomAxes<E[], R, D, E[]>
{
  declare readonly __valueT: E[];
  declare readonly __reqT: R;
  declare readonly __defT: D;
  declare readonly __injT: E[];

  required(): ArrayProp<E, true, D> {
    return clone(this, (ir) => { ir.required = true; }) as unknown as ArrayProp<E, true, D>;
  }
  default(value: E[] | ((ctx: DefaultCtx) => E[])): ArrayProp<E, true, true> {
    return clone(this, (ir) => setDefault(ir, value)) as unknown as ArrayProp<E, true, true>;
  }
  /** 元素集合语义：保序去重（spec 10 §3.1） */
  unique(): ArrayProp<E, R, D> {
    return clone(this, (ir) => {
      if (!ir.array) throw new Error("unique() 仅可用于数组属性");
      ir.array = { ...ir.array, elementUnique: true };
    });
  }
  /** 数组整体长度约束（元素级约束链在 .array() 之前的元素构建器上） */
  length(min: number, max?: number): ArrayProp<E, R, D> {
    return clone(this, (ir) => {
      if (!ir.array) throw new Error("length() 仅可用于数组属性");
      ir.array = { ...ir.array, arrayLength: { min, max } };
    });
  }
  displayName(name: string): ArrayProp<E, R, D> {
    return clone(this, (ir) => { ir.displayName = name; });
  }
  description(text: string): ArrayProp<E, R, D> {
    return clone(this, (ir) => { ir.description = text; });
  }
  status(status: Status): ArrayProp<E, R, D> {
    return clone(this, (ir) => { ir.status = status; });
  }
}

export type StringArrayProp<R extends boolean, D extends boolean> = ArrayProp<string, R, D>;
export type NumberArrayProp<T, R extends boolean, D extends boolean> = ArrayProp<T, R, D>;
export type EnumArrayProp<V extends string, R extends boolean, D extends boolean> = ArrayProp<V, R, D>;
export type PlainArrayProp<T, R extends boolean, D extends boolean> = ArrayProp<T, R, D>;
export type StructArrayProp<S, R extends boolean, D extends boolean> = ArrayProp<S, R, D>;

function toArrayProp(b: PropIRHolder): ArrayProp<unknown, boolean, boolean> {
  const ir = b.__ir;
  if (ir.type === "json" || ir.type === "ref") {
    throw new Error(`${ir.type} 属性不得转为数组（json 逃生舱可自含数组；ref 走链接，spec 10 §3.1）`);
  }
  return new ArrayProp({
    ...ir,
    type: `${ir.type}[]`,
    array: {
      element: {
        type: ir.type,
        values: ir.values,
        structApiName: ir.structApiName,
        length: ir.length,
        range: ir.range,
        regex: ir.regex,
      },
    },
    // 元素级约束已收入 array.element；数组层约束从零开始
    length: undefined,
    range: undefined,
    regex: undefined,
    unique: undefined,
    values: undefined,
    structApiName: undefined,
  } as PropIR) as ArrayProp<unknown, boolean, boolean>;
}

function normalizeRange(
  type: string,
  min: number | string,
  max?: number | string,
): { min?: number | string; max?: number | string } {
  if (typeof min === "number" && !Number.isFinite(min)) throw new Error("range 边界必须为有限数或十进制字符串");
  if (max !== undefined && typeof max === "number" && !Number.isFinite(max)) {
    throw new Error("range 边界必须为有限数或十进制字符串");
  }
  return { min, max };
}

/* ────────────────────────── prop 入口（`import { prop as p }`） ────────────────────────── */

function ir(type: string): PropIR {
  return { apiName: "", status: "active", type, required: false };
}

export const prop = {
  string: () => new StringProp(ir("string")),
  boolean: () => new PlainProp<boolean>(ir("boolean")),
  integer: () => new NumberProp<number>(ir("integer")),
  float: () => new NumberProp<number>(ir("float")),
  /** 任意精度十进制；TS/API 值域 = 字符串（JSON 字符串编码，spec 10 §3） */
  decimal: () => new NumberProp<string>(ir("decimal")),
  date: () => new PlainProp<string>(ir("date")),
  datetime: () => new PlainProp<string>(ir("datetime")),
  enum: <const V extends readonly string[]>(values: V): EnumProp<V[number]> => {
    if (values.length === 0) throw new Error("enum 值集不得为空（spec 10 §3）");
    return new EnumProp<V[number]>({ ...ir("enum"), values: [...values] });
  },
  json: () => new PlainProp<unknown>(ir("json")),
  /** 嵌入 struct（须先 structType 声明，spec 10 §2） */
  struct: <S>(def: StructMarker<S>): StructProp<StructShape<S>> =>
    new StructProp({ ...ir("struct"), structApiName: def.apiName }),
  /** 对象引用参数：传 UUID，execute 前注入完整对象（仅限动作/函数参数位） */
  ref: <T extends ObjectTypeMarker<any, any>>(target: () => T): RefProp<T> =>
    new RefProp({ ...ir("ref"), targetRef: target as () => unknown }),
};
