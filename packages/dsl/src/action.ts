/**
 * 动作（action）与只读函数（queryFn）——同构定义结构（spec 20 §2 / §11）。
 *
 * action = 语义层唯一写路径（单事务 execute）；
 * queryFn = 逻辑支柱 v1 唯一接口位（只读 q）。
 * execute 以源文本随定义 JSON 传输（spec 60 §2.1），服务端进程内执行。
 */
import type { Status } from "./definition.js";
import type { PropIRHolder } from "./props.js";
import { registerAction, registerQueryFn } from "./registry.js";
import type { ActionCtx, QueryCtx } from "./context-types.js";
import type { RuntimeProps } from "./shapes.js";

export class ActionMarker<P = any, R = unknown, N extends string = string> {
  declare readonly __hlApiName?: N;
  /** 判别幻影：与 QueryFnMarker 结构互赋（ActionCtx ⊇ QueryCtx 逆变）下约東路由 */
  declare readonly __hlCallable?: "action";
  constructor(
    public readonly apiName: string,
    public readonly displayName: string,
    public readonly description: string | undefined,
    public readonly status: Status,
    public readonly __paramIRs: ReadonlyMap<string, PropIRHolder>,
    public readonly __execute: (ctx: ActionCtx, params: any) => R,
  ) {}
}

export class QueryFnMarker<P = any, R = unknown, N extends string = string> {
  declare readonly __hlApiName?: N;
  /** 判别幻影：与 ActionMarker 结构互赋下约束路由 */
  declare readonly __hlCallable?: "queryfn";
  constructor(
    public readonly apiName: string,
    public readonly displayName: string,
    public readonly description: string | undefined,
    public readonly status: Status,
    public readonly __paramIRs: ReadonlyMap<string, PropIRHolder>,
    public readonly __execute: (q: QueryCtx, params: any) => R,
  ) {}
}

export interface ActionOpts<P extends Record<string, PropIRHolder>, R = unknown, N extends string = string> {
  apiName: N;
  displayName: string;
  description?: string;
  status?: Status;
  params: P;
  execute: (ctx: ActionCtx, params: RuntimeProps<P>) => R;
}

export interface QueryFnOpts<P extends Record<string, PropIRHolder>, R = unknown, N extends string = string> {
  apiName: N;
  displayName: string;
  description?: string;
  status?: Status;
  params: P;
  execute: (q: QueryCtx, params: RuntimeProps<P>) => R;
}

export function action<P extends Record<string, PropIRHolder>, R, const N extends string>(
  opts: ActionOpts<P, R, N>,
): ActionMarker<P, R, N> {
  const marker = new ActionMarker(
    opts.apiName,
    opts.displayName,
    opts.description,
    opts.status ?? "active",
    new Map(Object.entries(opts.params)),
    opts.execute as (ctx: ActionCtx, params: any) => R,
  );
  registerAction(marker);
  return marker as unknown as ActionMarker<P, R, N>;
}

export function queryFn<P extends Record<string, PropIRHolder>, R, const N extends string>(
  opts: QueryFnOpts<P, R, N>,
): QueryFnMarker<P, R, N> {
  const marker = new QueryFnMarker(
    opts.apiName,
    opts.displayName,
    opts.description,
    opts.status ?? "active",
    new Map(Object.entries(opts.params)),
    opts.execute as (q: QueryCtx, params: any) => R,
  );
  registerQueryFn(marker);
  return marker as unknown as QueryFnMarker<P, R, N>;
}
