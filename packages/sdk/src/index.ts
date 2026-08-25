/**
 * @heirloom/sdk —— 从本体源码同源编译的类型化 REST 客户端（spec 30 §1/§3）。
 *
 *   const sdk = createSdk({ url, token, ontology: await import("./ontology.js") });
 *   sdk.objects.employee.query({ filter: { status: { eq: "active" } }, count: true });
 *   sdk.actions.hireEmployee.invoke({ employeeNo: "E1", name: "张三", department: deptId });
 *   await sdk.assertSynced(); // 期望态 ↔ 生效态对账（spec 30 §3.5）
 *
 * 接口面 = 语义五端点 + revision 对账（管理面归 CLI，spec 30 §7）。
 * 类型层 = DSL 幻影直推（零 codegen）；运行时 = fetch 薄客户端。
 */
import {
  ActionMarker,
  ObjectTypeMarker,
  QueryFnMarker,
  materialize,
} from "@heirloom/dsl";
import { ApiError, api, request, type ClientOptions } from "./http.js";
import type {
  ActionApi,
  FunctionApi,
  GetOptions,
  MetaApi,
  ObjectApi,
  QueryBody,
} from "./types.js";

export { ApiError, api, request } from "./http.js";
export type { ClientOptions } from "./http.js";
export type * from "./types.js";

/* ────────────────────────── Sdk<O> 逆映射（导出名 → apiName 键控面） ────────────────────────── */

type ObjectEntries<O> = {
  [K in keyof O]: O[K] extends ObjectTypeMarker<any, any, infer N> ? [N, O[K]] : never;
}[keyof O];
type ActionEntries<O> = {
  [K in keyof O]: O[K] extends { readonly __hlCallable?: "action" }
    ? O[K] extends ActionMarker<any, any, infer N>
      ? [N, O[K]]
      : never
    : never
}[keyof O];
type FunctionEntries<O> = {
  [K in keyof O]: O[K] extends { readonly __hlCallable?: "queryfn" }
    ? O[K] extends QueryFnMarker<any, any, infer N>
      ? [N, O[K]]
      : never
    : never
}[keyof O];

export interface Sdk<O> {
  objects: { [E in ObjectEntries<O> as E[0] & string]: ObjectApi<E[1] & {}> };
  actions: { [E in ActionEntries<O> as E[0] & string]: ActionApi<E[1] & {}> };
  functions: { [E in FunctionEntries<O> as E[0] & string]: FunctionApi<E[1] & {}> };
  meta: MetaApi;
  /** 期望态（本地本体模块物化）↔ 生效态（服务端）对账；一致 → { revision }，漂移 → OntologyDriftError */
  assertSynced(): Promise<{ revision: number }>;
}

/** 期望态与生效态不一致（首差路径 + 服务端 revision；先 `heirloom ontology apply`） */
export class OntologyDriftError extends Error {
  constructor(
    readonly serverRevision: number,
    readonly firstDivergence: string,
  ) {
    super(
      `本体漂移：本地期望态与服务端生效定义不一致（server revision ${serverRevision}，首差 ${firstDivergence}）。先运行 heirloom ontology apply 收敛。`,
    );
    this.name = "OntologyDriftError";
  }
}

/* ────────────────────────── 运行时装配 ────────────────────────── */

function proxied(kind: string, target: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(target, {
    get(t, prop: string) {
      if (!(prop in t)) {
        throw new Error(`未知 ${kind} "${String(prop)}"——SDK 面按本体 apiName 键控（kebab-case）`);
      }
      return t[prop];
    },
  });
}

function objectApi(http: ClientOptions, marker: ObjectTypeMarker<any, any>): ObjectApi<any> {
  return {
    query: (body: QueryBody<any>) => request(http, "POST", `/v1/objects/${marker.apiName}/query`, body),
    get: (id: string, opts?: GetOptions<any> & { include?: string[]; ifMatch?: string }) => {
      const params = new URLSearchParams();
      for (const inc of opts?.include ?? []) params.append("include", inc);
      const qs = params.size > 0 ? `?${params.toString()}` : "";
      const headers = opts?.ifMatch !== undefined ? { "if-match": opts.ifMatch } : undefined;
      return request(http, "GET", `/v1/objects/${marker.apiName}/${id}${qs}`, undefined, headers);
    },
  } as never;
}

function callableApi(http: ClientOptions, kind: "actions" | "functions", marker: { apiName: string }) {
  return {
    invoke: (params: unknown) => api(http, "POST", `/v1/${kind}/${marker.apiName}/invoke`, params),
  };
}

/** 规范化序列化（键排序、数组保序）——比对期望态/生效态用 */
function canonical(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_k, v) => {
    if (v !== null && typeof v === "object") {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
      const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries);
    }
    return v;
  });
}

/** 首个分歧点路径（宽松匹配：数组按元素递归） */
function firstDivergence(local: unknown, remote: unknown, path: string): string {
  if (local === null || remote === null || typeof local !== "object" || typeof remote !== "object") {
    return local === remote ? "" : path;
  }
  if (Array.isArray(local) || Array.isArray(remote)) {
    const la = Array.isArray(local) ? local : [];
    const ra = Array.isArray(remote) ? remote : [];
    if (la.length !== ra.length) {
      const longer = la.length > ra.length ? la : ra;
      const extra = longer[Math.min(la.length, ra.length)];
      const tag =
        extra !== null && typeof extra === "object" && "apiName" in (extra as Record<string, unknown>)
          ? `（新增 ${String((extra as Record<string, unknown>).apiName)}）`
          : "";
      return `${path}（长度 ${la.length} ≠ ${ra.length}）${tag}`;
    }
    for (let i = 0; i < la.length; i++) {
      const d = firstDivergence(la[i], ra[i], `${path}[${i}]`);
      if (d) return d;
    }
    return "";
  }
  const lo = local as Record<string, unknown>;
  const ro = remote as Record<string, unknown>;
  const loKeys = new Set(Object.keys(lo).filter((k) => lo[k] !== undefined)); // undefined 值键 ≡ 缺席（与 JSON 编码一致）
  const roKeys = new Set(Object.keys(ro).filter((k) => ro[k] !== undefined));
  for (const key of new Set([...loKeys, ...roKeys])) {
    if (loKeys.has(key) !== roKeys.has(key)) {
      return `${path}.${key}（单侧缺失：${loKeys.has(key) ? "仅本地" : "仅服务端"}）`;
    }
    const d = firstDivergence(lo[key], ro[key], `${path}.${key}`);
    if (d) return d;
  }
  return "";
}

async function assertSynced(http: ClientOptions, bindings: Record<string, unknown>): Promise<{ revision: number }> {
  const local = materialize({ bindings });
  const remote = await request<{ revision: number; definition: unknown }>(http, "GET", "/v1/meta/ontology");
  if (canonical(local) === canonical(remote.definition)) return { revision: remote.revision };
  throw new OntologyDriftError(remote.revision, firstDivergence(local, remote.definition, "$") || "$");
}

export function createSdk<const O extends Record<string, unknown>>(opts: {
  url: string;
  token: string;
  /** 本体模块命名空间（import * as ontology）：标记按 apiName 装配键控面 */
  ontology: O;
}): Sdk<O> {
  const http: ClientOptions = { url: opts.url, token: opts.token };
  const objects: Record<string, unknown> = {};
  const actions: Record<string, unknown> = {};
  const functions: Record<string, unknown> = {};
  for (const value of Object.values(opts.ontology)) {
    if (value instanceof ObjectTypeMarker) objects[value.apiName] = objectApi(http, value);
    else if (value instanceof ActionMarker) actions[value.apiName] = callableApi(http, "actions", value);
    else if (value instanceof QueryFnMarker) functions[value.apiName] = callableApi(http, "functions", value);
  }
  materialize({ bindings: opts.ontology }); // 顺带在创建期做一次结构校验（悬空引用等本地即可拒）
  return {
    objects: proxied("对象类型", objects),
    actions: proxied("动作", actions),
    functions: proxied("函数", functions),
    meta: { ontology: () => request(http, "GET", "/v1/meta/ontology") },
    assertSynced: () => assertSynced(http, opts.ontology),
  } as unknown as Sdk<O>;
}
