/**
 * 形状映射 —— 构建器幻影轴 → 值形状（属性/参数共用，spec 10 §6 外形一项）。
 *
 * 三个视图：
 * - RuntimeProps：execute 内取回对象的形状（有默认值的属性视为恒存在）
 * - InputProps：create() 输入（required 必填；默认值/可选可缺省）
 * - PatchProps：modify() 局部更新（全部可缺省）
 */

type ValueOf<B> = B extends { readonly __valueT?: infer T } ? T : never;
type ReqOf<B> = B extends { readonly __reqT?: infer R } ? R : never;
type DefOf<B> = B extends { readonly __defT?: infer D } ? D : never;
type InjOf<B> = B extends { readonly __injT?: infer I } ? I : never;

/** execute 视角的值：ref 参数取注入类型（完整对象） */
type RuntimeValue<B> =
  ReqOf<B> extends true
    ? InjOf<B>
    : DefOf<B> extends true
      ? InjOf<B>
      : InjOf<B> | undefined;

/** 输入视角的值：required 且无默认值才必填（默认值/可选参数可缺省）；ref = UUID 字符串 */
type InputValue<B> =
  ReqOf<B> extends true
    ? DefOf<B> extends true
      ? ValueOf<B> | undefined
      : ValueOf<B>
    : ValueOf<B> | undefined;

type RuntimeRequiredKeys<P> = { [K in keyof P]-?: undefined extends RuntimeValue<P[K]> ? never : K }[keyof P];

export type RuntimeProps<P> = {
  [K in keyof P as K extends RuntimeRequiredKeys<P> ? K : never]: RuntimeValue<P[K]>;
} & {
  [K in keyof P as K extends Exclude<keyof P, RuntimeRequiredKeys<P>> ? K : never]?: RuntimeValue<P[K]>;
};

type InputRequiredKeys<P> = { [K in keyof P]-?: undefined extends InputValue<P[K]> ? never : K }[keyof P];

export type InputProps<P> = {
  [K in keyof P as K extends InputRequiredKeys<P> ? K : never]: InputValue<P[K]>;
} & {
  [K in keyof P as K extends Exclude<keyof P, InputRequiredKeys<P>> ? K : never]?: InputValue<P[K]>;
};

export type PatchProps<P> = { [K in keyof P]?: ValueOf<P[K]> };
