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

export class ActionMarker<P = any> {
  constructor(
    public readonly apiName: string,
    public readonly displayName: string,
    public readonly description: string | undefined,
    public readonly status: Status,
    public readonly __paramIRs: ReadonlyMap<string, PropIRHolder>,
    public readonly __execute: (ctx: ActionCtx, params: any) => unknown,
  ) {}
}

export class QueryFnMarker<P = any> {
  constructor(
    public readonly apiName: string,
    public readonly displayName: string,
    public readonly description: string | undefined,
    public readonly status: Status,
    public readonly __paramIRs: ReadonlyMap<string, PropIRHolder>,
    public readonly __execute: (q: QueryCtx, params: any) => unknown,
  ) {}
}

export interface ActionOpts<P extends Record<string, PropIRHolder>> {
  apiName: string;
  displayName: string;
  description?: string;
  status?: Status;
  params: P;
  execute: (ctx: ActionCtx, params: RuntimeProps<P>) => unknown;
}

export interface QueryFnOpts<P extends Record<string, PropIRHolder>> {
  apiName: string;
  displayName: string;
  description?: string;
  status?: Status;
  params: P;
  execute: (q: QueryCtx, params: RuntimeProps<P>) => unknown;
}

export function action<P extends Record<string, PropIRHolder>>(opts: ActionOpts<P>): ActionMarker<P> {
  const marker = new ActionMarker(
    opts.apiName,
    opts.displayName,
    opts.description,
    opts.status ?? "active",
    new Map(Object.entries(opts.params)),
    opts.execute as (ctx: ActionCtx, params: any) => unknown,
  );
  registerAction(marker);
  return marker as unknown as ActionMarker<P>;
}

export function queryFn<P extends Record<string, PropIRHolder>>(opts: QueryFnOpts<P>): QueryFnMarker<P> {
  const marker = new QueryFnMarker(
    opts.apiName,
    opts.displayName,
    opts.description,
    opts.status ?? "active",
    new Map(Object.entries(opts.params)),
    opts.execute as (q: QueryCtx, params: any) => unknown,
  );
  registerQueryFn(marker);
  return marker as unknown as QueryFnMarker<P>;
}
