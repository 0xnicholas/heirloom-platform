/**
 * 执行上下文类型 —— 动作 ctx（写五件套）与 queryFn q（只读）。
 *
 * 类型层在此声明；运行时实现属引擎（活事务协调器）。类型打头、与正向
 * 遍历对称的编辑操作四参形态是 spec 10 §6 外形七项。
 */
import type { CreateInput, Obj, ObjectTypeMarker } from "./object.js";

/** 主判定依据（spec 20 §3：ctx 必须至少暴露） */
export interface CtxIdentity {
  readonly userId: string;
  readonly groups: readonly string[];
  readonly today: string;
  readonly now: string;
}

export interface ModifyOpts {
  /** 乐观锁锚 updated_at（spec 20 §8）；命中旧值 → 整事务回滚 */
  expectedUpdatedAt?: string;
}

/** 动作执行上下文：活事务内可用操作全集（spec 20 §5–§6） */
export interface ActionCtx extends CtxIdentity {
  /** 建对象；UUIDv7 事务前预生成，返回含 id 的完整对象 */
  create<T extends ObjectTypeMarker<any, any>>(type: T, props: CreateInput<T>): Obj<T>;

  /** 部分更新；opts.expectedUpdatedAt 启用乐观锁 */
  modify<T extends ObjectTypeMarker<any, any>>(
    type: T,
    obj: Obj<T>,
    patch: Partial<Obj<T>>,
    opts?: ModifyOpts,
  ): Obj<T>;

  /** 删除；required 链接阻止 / optional 自动摘链（spec 40 §4） */
  delete<T extends ObjectTypeMarker<any, any>>(obj: Obj<T>): void;

  /** 建链接；1:N 下 link 即移动（旧侧自动摘除）；全基数语义一致 */
  link<T extends ObjectTypeMarker<any, any>, K extends string & keyof LinkMap<T>>(
    type: T,
    obj: Obj<T>,
    linkName: K,
    target: Obj<any>,
  ): void;

  /** 摘链接 */
  unlink<T extends ObjectTypeMarker<any, any>>(type: T, obj: Obj<T>, linkName: string, target: Obj<any>): void;

  /** 全量取回（活事务内 RYW：含本事务已写）；行级谓词只管读面——execute 全量可见（spec 50 §8） */
  all<T extends ObjectTypeMarker<any, any>>(type: T): Obj<T>[];

  /** 按 id 取单对象（含本事务已建） */
  get<T extends ObjectTypeMarker<any, any>>(type: T, id: string): Obj<T> | undefined;

  /** 正向遍历：链接名带类型（返回数组，全基数统一） */
  linked<T extends ObjectTypeMarker<any, any>, K extends string & keyof LinkMap<T>>(
    type: T,
    obj: Obj<T>,
    linkName: K,
  ): Obj<LinkMap<T>[K]>[];

  /** 反向遍历：按反向名，运行时校验、弱类型（v1，spec 10 §4） */
  backlinks<T extends ObjectTypeMarker<any, any>>(type: T, obj: any, reverseName: string): any[];
}

/** 只读函数上下文：无写操作（spec 20 §11）；读授权照常生效 */
export interface QueryCtx {
  all<T extends ObjectTypeMarker<any, any>>(type: T): Obj<T>[];
  get<T extends ObjectTypeMarker<any, any>>(type: T, id: string): Obj<T> | undefined;
  linked<T extends ObjectTypeMarker<any, any>, K extends string & keyof LinkMap<T>>(
    type: T,
    obj: Obj<T>,
    linkName: K,
  ): Obj<LinkMap<T>[K]>[];
  backlinks<T extends ObjectTypeMarker<any, any>>(type: T, obj: any, reverseName: string): any[];
}

/** ObjectTypeMarker 的链接映射视图（linked 类型推断用）：解开 LinkMarker 幻影取目标类型 */
type LinkMap<T> = T extends ObjectTypeMarker<any, infer L>
  ? { [K in keyof L]: L[K] extends { readonly __hlTargetT?: infer Target } ? Target : never }
  : never;
