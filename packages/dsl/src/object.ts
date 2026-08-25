/**
 * 对象类型 —— 有 UUID 身份、可链接、可独立查询与授权的实体类型（spec 10 §2）。
 *
 * 幻影携带原始属性构建器记录与链接目标映射：
 * - Obj<T> 取值形状（含 id）
 * - ctx.create(T, props) 输入形状（required 必填、默认值可缺省）
 * - linked(T, obj, 'name') 正向遍历类型（反向 backlinks 弱类型——v1，spec 10 §4）
 */
import type { Status } from "./definition.js";
import type { LinkMarker } from "./link.js";
import type { PropIRHolder } from "./props.js";
import { registerObjectType } from "./registry.js";
import type { InputProps, RuntimeProps } from "./shapes.js";

declare const OBJ_PROPS: unique symbol;
declare const OBJ_LINKS: unique symbol;

export class ObjectTypeMarker<P = any, L = any, N extends string = string> {
  declare readonly __hlApiName?: N;
  readonly __hlPropsP?: P;
  readonly __hlLinksL?: L;
  constructor(
    public readonly apiName: string,
    public readonly displayName: string,
    public readonly description: string | undefined,
    public readonly status: Status,
    /** 属性名 → 构建器（保持声明序） */
    public readonly __propIRs: ReadonlyMap<string, PropIRHolder>,
    /** 链接名 → 标记（保持声明序） */
    public readonly __linkIRs: ReadonlyMap<string, LinkMarker<any>>,
  ) {}
}

export function objectType<P extends Record<string, PropIRHolder>, L extends Record<string, LinkMarker<any>>, const N extends string>(opts: {
  apiName: N;
  displayName: string;
  description?: string;
  status?: Status;
  properties: P;
  links?: L;
}): ObjectTypeMarker<P, L, N> {
  const marker = new ObjectTypeMarker(
    opts.apiName,
    opts.displayName,
    opts.description,
    opts.status ?? "active",
    new Map(Object.entries(opts.properties)),
    new Map(Object.entries(opts.links ?? {})),
  );
  registerObjectType(marker);
  return marker as unknown as ObjectTypeMarker<P, L, N>;
}

/** 链接名 → 目标类型标记（遍历类型推断用） */
export type LinkTargets<L> = L extends Record<string, LinkMarker<any>>
  ? { [K in keyof L]: L[K] extends LinkMarker<infer T> ? T : never }
  : never;

/** 运行时对象：id + 属性取值形状（execute / queryFn 内所见） */
export type Obj<T> = T extends ObjectTypeMarker<infer P, any>
  ? { id: string; updatedAt?: string } & RuntimeProps<P>
  : never;

/** create() 输入形状 */
export type CreateInput<T> = T extends ObjectTypeMarker<infer P, any> ? InputProps<P> : never;
