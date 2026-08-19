/**
 * struct —— 无身份嵌入值（spec 10 §2）：可复用、可嵌套（≤2 层）、
 * 不得参与链接、无独立查询与授权。
 */
import type { Status } from "./definition.js";
import type { PropIRHolder } from "./props.js";
import { registerStruct } from "./registry.js";
import type { RuntimeProps } from "./shapes.js";

/** struct 标记：幻影携带原始属性构建器记录，形状映射统一走幻影轴 */
export class StructMarker<P = any> {
  declare readonly __hlStructP?: P;
  constructor(
    public readonly apiName: string,
    public readonly displayName: string,
    public readonly description: string | undefined,
    public readonly status: Status,
    /** 原始属性构建器记录（保持声明序；物化与校验用） */
    public readonly __propIRs: ReadonlyMap<string, PropIRHolder>,
  ) {}
}

export function structType<P extends Record<string, PropIRHolder>>(opts: {
  apiName: string;
  displayName: string;
  description?: string;
  status?: Status;
  properties: P;
}): StructMarker<P> {
  const marker = new StructMarker(
    opts.apiName,
    opts.displayName,
    opts.description,
    opts.status ?? "active",
    new Map(Object.entries(opts.properties)),
  );
  registerStruct(marker);
  return marker as unknown as StructMarker<P>;
}

/** struct 值形状（嵌入属性位的 TS 类型） */
export type StructShape<S> = S extends { readonly __hlStructP?: infer P } ? RuntimeProps<P> : never;
