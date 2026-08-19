/**
 * 定义 JSON —— 本体经 CLI 物化后的语言中性传输格式（spec 60 §2.1）。
 *
 * 这是 DSL 包与引擎之间的唯一契约：客户端（CLI）物化产出，服务端（push 端点）
 * 接收并按 60 章管线收敛。动作/queryFn 的 execute 函数体以源文本随定义传输。
 */

export type Status = "experimental" | "active" | "deprecated";

export type ScalarTypeName =
  | "string"
  | "boolean"
  | "integer"
  | "float"
  | "decimal"
  | "date"
  | "datetime"
  | "enum"
  | "json";

export type Cardinality = "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";

/** 元数据（spec 10 §1：apiName + displayName 必须；description 可选） */
export interface NamedMeta {
  apiName: string;
  displayName: string;
  description?: string;
}

/** 静态字面量默认值 或 动态默认（(ctx) => value 的源文本）——spec 10 §3 / 20 §3 */
export type DefaultSpec =
  | { kind: "static"; value: string | number | boolean | null }
  | { kind: "dynamic"; source: string };

/** 元素约束（数组属性的内层定义） */
export interface ElementDef {
  type: ScalarTypeName | "struct";
  /** enum：封闭值集（不得为空） */
  values?: string[];
  /** struct：引用的 struct apiName */
  struct?: string;
  /** ref：目标对象类型 apiName（仅参数位出现，类型属性不得用 ref——spec 10 §3.1） */
  target?: string;
  length?: { min?: number; max?: number };
  range?: { min?: number | string; max?: number | string };
  regex?: { source: string; flags?: string };
}

/** 属性定义（对象类型属性与动作参数共用编码；参数额外可用 ref/dynamic default） */
export interface PropertyDef extends NamedMeta {
  /** string | boolean | … | enum | json | struct | ref | `${scalar}[]` */
  type: string;
  status: Status;
  required: boolean;
  /** 业务键 / 参数缺省性之外的唯一性声明 */
  unique?: boolean;
  /** 数组语义；元素约束在 element，unique=元素集合语义（保序去重），length=数组长度 */
  array?: {
    element: ElementDef;
    unique?: boolean;
    length?: { min?: number; max?: number };
  };
  length?: { min?: number; max?: number };
  range?: { min?: number | string; max?: number | string };
  regex?: { source: string; flags?: string };
  values?: string[];
  struct?: string;
  /** ref 参数：execute 前注入完整对象（spec 20 §3）；类型属性不得使用 */
  target?: string;
  default?: DefaultSpec;
}

export interface LinkDef extends NamedMeta {
  status: Status;
  cardinality: Cardinality;
  /** 目标对象类型 apiName */
  target: string;
  /** 反向遍历名：显式或按派生规则（声明方 apiName 原样，spec 10 §4） */
  reverse: string;
  required: boolean;
}

export interface StructDef extends NamedMeta {
  status: Status;
  properties: PropertyDef[];
}

export interface ObjectTypeDef extends NamedMeta {
  status: Status;
  properties: PropertyDef[];
  links: LinkDef[];
}

export interface CallableDef extends NamedMeta {
  status: Status;
  /** 参数名 → 定义（ref/struct/标量 + 默认值） */
  params: Record<string, PropertyDef>;
  /** 函数体源文本（箭头函数全源，含参数列表） */
  executeSource: string;
}

export interface OntologyDefinition {
  structs: StructDef[];
  objectTypes: ObjectTypeDef[];
  actions: CallableDef[];
  functions: CallableDef[];
  /**
   * 标识符 → apiName 绑定表：物化时从本体模块导出收集（导出名即 execute
   * 源文本自由变量的解析域）。服务端据此在进程内重建 execute 的闭包环境。
   */
  bindings: Record<string, { kind: "object" | "struct"; apiName: string }>;
}

export const DSL_BINDING_NAMES = [
  "p",
  "prop",
  "objectType",
  "structType",
  "link",
  "action",
  "queryFn",
  "ValidationFailed",
  "PermissionDenied",
] as const;

/** execute 源文本内允许引用的全局（进程内执行可信代码；安全边界在 API 面） */
export const EXECUTE_GLOBALS: ReadonlySet<string> = new Set([
  "JSON",
  "Math",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "Map",
  "Set",
  "Symbol",
  "BigInt",
  "Intl",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "NaN",
  "Infinity",
  "undefined",
  "console",
  "globalThis",
]);
