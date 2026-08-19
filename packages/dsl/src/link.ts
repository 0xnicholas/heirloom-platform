/**
 * 一等链接 —— 四基数助手（spec 10 §4 / §6 外形八项之二、三、四）。
 *
 * 目标一律 thunk（前向引用与自引用常态）；自引用标注 `(): any => T`
 * （TS 循环初始化限制，drizzle 同款）。反向名显式给出或按派生规则
 * 省略（= 声明方对象类型 apiName 原样，不加复数）。
 */
import type { Cardinality, Status } from "./definition.js";

export interface LinkOpts {
  /** 反向遍历名；省略时按派生规则 = 声明方 apiName 原样 */
  reverse?: string;
  displayName?: string;
  description?: string;
  /** 声明后：写事务提交时必须已链接，否则整事务回滚（spec 10 §4） */
  required?: boolean;
  status?: Status;
}

/** 链接中间表示（物化前；target thunk 延迟到全模块求值后解析） */
export interface LinkIR {
  cardinality: Cardinality;
  targetThunk: () => unknown;
  reverse?: string;
  displayName?: string;
  description?: string;
  required: boolean;
  status: Status;
}

/** 链接标记：幻影携带目标类型，供 linked() 正向遍历类型推断 */
export class LinkMarker<T = any> {
  declare readonly __hlTargetT?: T;
  constructor(public readonly __ir: LinkIR) {}
}

function linkDef<T>(cardinality: Cardinality, target: () => T, opts: LinkOpts = {}): LinkMarker<T> {
  if (typeof target !== "function") {
    throw new Error("链接目标必须为 thunk（如 () => Employee）——前向/自引用一致性（spec 10 §6 外形三）");
  }
  return new LinkMarker<T>({
    cardinality,
    targetThunk: target,
    reverse: opts.reverse,
    displayName: opts.displayName,
    description: opts.description,
    required: opts.required ?? false,
    status: opts.status ?? "active",
  });
}

export const link = {
  oneToOne: <T>(target: () => T, opts?: LinkOpts): LinkMarker<T> => linkDef("one-to-one", target, opts),
  oneToMany: <T>(target: () => T, opts?: LinkOpts): LinkMarker<T> => linkDef("one-to-many", target, opts),
  manyToOne: <T>(target: () => T, opts?: LinkOpts): LinkMarker<T> => linkDef("many-to-one", target, opts),
  manyToMany: <T>(target: () => T, opts?: LinkOpts): LinkMarker<T> => linkDef("many-to-many", target, opts),
};
