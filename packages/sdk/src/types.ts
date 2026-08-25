/**
 * 类型层 —— DSL 幻影 → 线上调用面（spec 30 §1「SDK 从本体源码同源编译」）。
 *
 * 投影规则与引擎执行面逐条对齐（spec 40 §6 算子封闭集 / 排序 / include）：
 * - string 独享 contains/startsWith；decimal/date/datetime 可比较不可 LIKE；
 *   boolean 无比较；数组只 contains-any；json/struct 只 null 检查
 * - 过滤叶子 = 本类型属性 + 系统字段（id/createdAt/updatedAt）+ 一跳链接属性
 *   （点路径）；排序 = 本类型标量属性 + 系统字段；include = 声明链接 ≤2 跳
 * - 反向链接遍历 v1 弱类型（DSL 同款限制，spec 10 §4）——include 点路径
 *   仅覆盖声明侧链接名
 */
import type {
  ActionMarker,
  ArrayProp,
  EnumProp,
  InputProps,
  LinkMarker,
  NumberProp,
  ObjectTypeMarker,
  Obj,
  PlainProp,
  StringProp,
  StructProp,
} from "@heirloom/dsl";

/* ────────────────────────── 值/叶子工具 ────────────────────────── */

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/** 一跳路径解析中的链接名（keyof L 包装） */
type LinkKey<L> = keyof L & string;

/* ────────────────────────── 过滤算子（镜像引擎 applyOp 矩阵） ────────────────────────── */

interface ScalarOps<V> {
  eq?: V | null;
  neq?: V | null;
  in?: readonly V[];
  gt?: V;
  gte?: V;
  lt?: V;
  lte?: V;
}

interface StringOps extends ScalarOps<string> {
  contains?: string;
  startsWith?: string;
}

type ElementOf<A> = A extends readonly (infer E)[] ? E : never;

export type OpsFor<B> =
  B extends StringProp<any, any>
    ? StringOps
    : B extends NumberProp<any, any, any>
      ? Val<B> extends number
        ? ScalarOps<number>
        : ScalarOps<string>
      : B extends EnumProp<any, any, any>
        ? ScalarOps<Val<B>>
        : B extends PlainProp<any, any, any>
          ? Val<B> extends boolean
            ? { eq?: boolean | null; neq?: boolean | null; in?: readonly boolean[] }
            : Val<B> extends string
              ? ScalarOps<string>
              : { eq?: null; neq?: null }
          : B extends StructProp<any, any, any>
            ? { eq?: null; neq?: null }
            : B extends ArrayProp<any, any, any>
              ? { eq?: null; neq?: null; "contains-any"?: readonly ElementOf<Val<B>>[] }
              : never;

type Val<B> = B extends { readonly __valueT?: infer T } ? T : never;

/** 系统字段（水位线增量拉取所需；引擎映射 created_at/updated_at 列） */
interface SystemLeaves {
  id?: ScalarOps<string>;
  createdAt?: ScalarOps<string>;
  updatedAt?: ScalarOps<string>;
}

/* ────────────────────────── 过滤表达式 ────────────────────────── */

type POf<T> = T extends ObjectTypeMarker<infer P, any> ? P : never;

type LinkTarget<LM> = LM extends LinkMarker<infer TT, any> ? TT : never;

/** 一跳叶子：`${链接名}.${属性名}`（EXISTS 下推；各跳行级谓词照常注入） */
type HopLeaves<T> = T extends ObjectTypeMarker<any, infer L>
  ? UnionToIntersection<
      {
        [K in LinkKey<L>]: {
          [PP in keyof POf<LinkTarget<L[K]>> & string as `${K}.${PP}`]?: OpsFor<POf<LinkTarget<L[K]>>[PP]>;
        };
      }[LinkKey<L>]
    >
  : never;

export type FilterNode<T> = {
  and?: readonly FilterNode<T>[];
  or?: readonly FilterNode<T>[];
  not?: FilterNode<T>;
} & SystemLeaves &
  { [K in keyof POf<T> & string]?: OpsFor<POf<T>[K]> } &
  HopLeaves<T>;

/* ────────────────────────── 排序 / include ────────────────────────── */

type IsScalarProp<B> =
  B extends StringProp<any, any>
    ? true
    : B extends NumberProp<any, any, any>
      ? true
      : B extends EnumProp<any, any, any>
        ? true
        : B extends PlainProp<any, any, any>
          ? true
          : false;

export type SortField<T> =
  | { [K in keyof POf<T> & string]: IsScalarProp<POf<T>[K]> extends true ? K : never }[keyof POf<T> & string]
  | "id"
  | "createdAt"
  | "updatedAt";

export interface SortItem<T> {
  field: SortField<T>;
  dir: "asc" | "desc";
}

type LinkKeys<T> = T extends ObjectTypeMarker<any, infer L> ? LinkKey<L> : never;

/** include 点路径：声明链接 ≤2 跳 */
export type IncludePath<T> =
  | LinkKeys<T>
  | {
      [K in LinkKeys<T>]: LinkTarget<
        T extends ObjectTypeMarker<any, infer L> ? L[K & LinkKey<L>] : never
      > extends ObjectTypeMarker<any, infer L2>
        ? keyof { [K2 in LinkKey<L2> as `${K}.${K2}`]: 0 }
        : never;
    }[LinkKeys<T>];

/** 链接挂载形状：单值（1:1 / N:1）→ 对象|null；多值（1:N / M:N）→ 数组 */
type MountOfLink<LM> =
  LM extends LinkMarker<infer TT, infer C>
    ? C extends "one-to-one" | "many-to-one"
      ? Obj<TT> | null
      : Obj<TT>[]
    : never;

type LinkOf<T, K extends string> = T extends ObjectTypeMarker<any, infer L> ? L[K & LinkKey<L>] : never;

type MountAndEmbed<T, K1 extends string, K2 extends string> =
  LinkOf<T, K1> extends LinkMarker<infer TT, any>
    ? LinkOf<T, K1> extends LinkMarker<any, infer C>
      ? C extends "one-to-one" | "many-to-one"
        ? (Obj<TT> & { [KK in K2]: MountOfLink<LinkOf<TT, K2>> }) | null
        : Array<Obj<TT> & { [KK in K2]: MountOfLink<LinkOf<TT, K2>> }>
      : never
    : never;

type ApplyPath<T, P extends string> =
  P extends `${infer K1}.${infer K2}`
    ? { [KK1 in K1 & string]: MountAndEmbed<T, K1 & string, K2 & string> }
    : { [KK in P & string]: MountOfLink<LinkOf<T, P>> };

/** include 挂载叠加（多路径交集合并；未 include = {}；可选属性位扗 undefined） */
export type Mounted<T, Ps> =
  NonNullable<Ps> extends readonly (infer P extends string)[]
    ? UnionToIntersection<P extends string ? ApplyPath<T, P> : never>
    : {};

/* ────────────────────────── 请求/响应体 ────────────────────────── */

export interface QueryBody<T> {
  filter?: FilterNode<T>;
  sort?: SortSpec<T>;
  cursor?: string;
  limit?: number;
  include?: readonly IncludePath<T>[];
  count?: boolean;
}

export interface QueryResult<T, Ps> {
  data: (Obj<T> & Mounted<T, Ps>)[];
  nextCursor?: string;
  count?: number;
}

export interface GetOptions<T> {
  include?: readonly IncludePath<T>[];
  /** If-Match 并发头：旧值 → 409 PRECONDITION_FAILED（spec 30 §3.2） */
  ifMatch?: string;
}

export interface ObjectApi<T> {
  query<const B extends QueryBody<T>>(body: B): Promise<QueryResult<T, B["include"]>>;
  get<const O extends GetOptions<T>>(id: string, opts?: O): Promise<{ data: Obj<T> & Mounted<T, O["include"]> }>;
}

export interface ActionApi<A> {
  invoke(params: A extends ActionMarker<infer P, any, any> ? InputProps<P> : never): Promise<{
    data: A extends ActionMarker<any, infer R, any> ? R : never;
  }>;
}

export interface FunctionApi<F> {
  invoke(params: F extends import("@heirloom/dsl").QueryFnMarker<infer P, any, any> ? InputProps<P> : never): Promise<{
    data: F extends import("@heirloom/dsl").QueryFnMarker<any, infer R, any> ? R : never;
  }>;
}

export interface MetaApi {
  /** 当前生效定义 + revision（版本锚点，spec 30 §3.5） */
  ontology(): Promise<{ revision: number; definition: unknown }>;
}

/** 排序键元组（≤3 键；id 隐式末位锥——稳定排序） */
export type SortSpec<T> = readonly [SortItem<T>?, SortItem<T>?, SortItem<T>?];
