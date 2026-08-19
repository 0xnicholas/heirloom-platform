/**
 * 物化 —— registry → 定义 JSON（spec 60 §2.1）。
 *
 * CLI 在本地 Node 进程求值本体 TS 模块后调用：
 *   1. 解析全部链接目标 thunk（全模块求值后方安全——前向/自引用）；
 *   2. 序列化属性/链接/动作/函数（execute 与动态默认以源文本传输）；
 *   3. 从模块导出收集标识符绑定表；
 *   4. 结构校验先行拒绝（与 push 服务端同一校验器）。
 */
import type {
  CallableDef,
  DefaultSpec,
  ElementDef,
  LinkDef,
  ObjectTypeDef,
  OntologyDefinition,
  PropertyDef,
  StructDef,
} from "./definition.js";
import { assertValidDefinition } from "./validate.js";
import type { ActionMarker, QueryFnMarker } from "./action.js";
import type { ObjectTypeMarker } from "./object.js";
import type { StructMarker } from "./struct.js";
import { registry } from "./registry.js";
import type { PropIR, PropIRHolder } from "./props.js";
import { findDanglingIdentifiers } from "./free-identifiers.js";

const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;

function elementDefOf(ir: PropIR): ElementDef {
  const el = ir.array?.element;
  const out: ElementDef = { type: (el?.type ?? ir.type) as ElementDef["type"] };
  if (el?.values?.length) out.values = el.values;
  if (el?.structApiName) out.struct = el.structApiName;
  if (el?.length) out.length = el.length;
  if (el?.range) {
    out.range = el.range;
    if (el.type === "decimal") {
      out.range = { min: norm(el.range.min), max: norm(el.range.max) };
    }
  }
  if (el?.regex) out.regex = el.regex;
  return out;
}

function norm(v: number | string | undefined): number | string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") {
    if (!DECIMAL_RE.test(v)) throw new Error(`decimal 边界 "${v}" 非法十进制文法`);
    return v;
  }
  return v;
}

function propDefOf(apiName: string, holder: PropIRHolder): PropertyDef {
  const ir = holder.__ir as PropIR;
  const def: PropertyDef = {
    apiName,
    type: "json",
    displayName: ir.displayName ?? apiName,
    status: ir.status,
    required: ir.required,
  };
  if (ir.description) def.description = ir.description;

  if (ir.targetRef) {
    // ref 参数：target 由物化主流程解析（thunk 延迟）
    def.type = "ref";
  } else if (ir.structApiName) {
    def.type = "struct";
    def.struct = ir.structApiName;
  } else if (ir.array) {
    def.type = `${ir.array.element.type}[]`;
    def.array = {
      element: elementDefOf(ir),
      ...(ir.array.elementUnique ? { unique: true } : {}),
      ...(ir.array.arrayLength ? { length: ir.array.arrayLength } : {}),
    };
  } else {
    def.type = ir.type as PropertyDef["type"];
  }

  if (ir.values) def.values = ir.values;
  if (ir.unique) def.unique = true;
  if (ir.length && !ir.array) def.length = ir.length;
  if (ir.range && !ir.array) {
    def.range = ir.type === "decimal" ? { min: norm(ir.range.min), max: norm(ir.range.max) } : ir.range;
  }
  if (ir.regex && !ir.array) def.regex = ir.regex;
  if (ir.default) def.default = ir.default;
  return def;
}

function resolveRefTarget(holder: PropIRHolder, path: string): string {
  const ir = holder.__ir as PropIR;
  if (!ir.targetRef) throw new Error(`${path}: 非 ref 属性`);
  let resolved: unknown;
  try {
    resolved = ir.targetRef();
  } catch (e) {
    throw new Error(`${path}: ref 目标 thunk 求值失败（循环初始化？）——${(e as Error).message}`);
  }
  const marker = resolved as ObjectTypeMarker<any, any> | undefined;
  if (!marker || !marker.apiName || !registry.objectTypes.has(marker.apiName)) {
    throw new Error(`${path}: ref 目标必须是已注册的对象类型`);
  }
  return marker.apiName;
}

function linkDefOf(declarer: string, linkName: string, marker: { __ir: { cardinality: LinkDef["cardinality"]; targetThunk: () => unknown; reverse?: string; displayName?: string; description?: string; required: boolean; status: LinkDef["status"] } }): LinkDef {
  let target: unknown;
  try {
    target = marker.__ir.targetThunk();
  } catch (e) {
    throw new Error(`${declarer}.${linkName}: 链接目标 thunk 求值失败（循环初始化？）——${(e as Error).message}`);
  }
  const targetMarker = target as ObjectTypeMarker<any, any> | undefined;
  if (!targetMarker || !targetMarker.apiName || !registry.objectTypes.has(targetMarker.apiName)) {
    throw new Error(`${declarer}.${linkName}: 链接目标必须是已注册的对象类型`);
  }
  return {
    apiName: linkName,
    displayName: marker.__ir.displayName ?? linkName,
    ...(marker.__ir.description ? { description: marker.__ir.description } : {}),
    status: marker.__ir.status,
    cardinality: marker.__ir.cardinality,
    target: targetMarker.apiName,
    // 派生规则：声明方 apiName 原样，不加复数（spec 10 §4）
    reverse: marker.__ir.reverse ?? declarer,
    required: marker.__ir.required,
  };
}

function callableDefOf(marker: ActionMarker<any> | QueryFnMarker<any>): CallableDef {
  const def: CallableDef = {
    apiName: marker.apiName,
    displayName: marker.displayName,
    ...(marker.description ? { description: marker.description } : {}),
    status: marker.status,
    params: {},
    executeSource: String(marker.__execute),
  };
  for (const [name, holder] of marker.__paramIRs) {
    def.params[name] = propDefOf(name, holder);
    if (def.params[name]!.type === "ref") {
      def.params[name]!.target = resolveRefTarget(holder, `${marker.apiName}.${name}`);
    }
  }
  return def;
}

export interface MaterializeOptions {
  /**
   * 模块导出表（标识符 → 值）：物化从中筛出 ObjectTypeMarker/StructMarker
   * 生成绑定表——本体模块必须导出 execute 源文本中引用到的类型。
   */
  bindings?: Record<string, unknown>;
}

export function materialize(options: MaterializeOptions = {}): OntologyDefinition {
  const structs: StructDef[] = [];
  for (const s of registry.structs.values()) {
    const marker = s as StructMarker<any>;
    const def: StructDef = {
      apiName: marker.apiName,
      displayName: marker.displayName,
      ...(marker.description ? { description: marker.description } : {}),
      status: marker.status,
      properties: [],
    };
    for (const [name, holder] of marker.__propIRs) {
      const pd = propDefOf(name, holder);
      if (pd.type === "ref") throw new Error(`struct.${marker.apiName}.${name}: struct 内不得使用 ref`);
      def.properties.push(pd);
    }
    structs.push(def);
  }

  const objectTypes: ObjectTypeDef[] = [];
  for (const t of registry.objectTypes.values()) {
    const marker = t as ObjectTypeMarker<any, any>;
    const def: ObjectTypeDef = {
      apiName: marker.apiName,
      displayName: marker.displayName,
      ...(marker.description ? { description: marker.description } : {}),
      status: marker.status,
      properties: [],
      links: [],
    };
    for (const [name, holder] of marker.__propIRs) {
      const pd = propDefOf(name, holder);
      if (pd.type === "ref") {
        throw new Error(`objectType.${marker.apiName}.${name}: 对象引用只能作参数，不能作属性（spec 10 §3.1）`);
      }
      def.properties.push(pd);
    }
    for (const [name, lm] of marker.__linkIRs) {
      def.links.push(linkDefOf(marker.apiName, name, lm as never));
    }
    objectTypes.push(def);
  }

  const actions = [...registry.actions.values()].map((a) => callableDefOf(a));
  const functions = [...registry.functions.values()].map((f) => callableDefOf(f));

  // 绑定表：导出名 → 类型/struct（execute 源文本自由变量的解析域）
  const bindings: OntologyDefinition["bindings"] = {};
  for (const [ident, value] of Object.entries(options.bindings ?? {})) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ident)) continue;
    const v = value as ObjectTypeMarker<any, any> | StructMarker<any> | undefined;
    if (v && typeof v === "object" && "apiName" in v) {
      if (registry.objectTypes.has(v.apiName)) bindings[ident] = { kind: "object", apiName: v.apiName };
      else if (registry.structs.has(v.apiName)) bindings[ident] = { kind: "struct", apiName: v.apiName };
    }
  }

  const def: OntologyDefinition = { structs, objectTypes, actions, functions, bindings };

  // 客户端预检：悬空引用给更早的失败信号（服务端 push 仍权威复检）
  for (const c of [...def.actions, ...def.functions]) {
    const { dangling } = findDanglingIdentifiers(c.executeSource, def.bindings);
    if (dangling.length > 0) {
      throw new Error(
        `${c.apiName}.execute 引用了未导出的标识符：${dangling.join(", ")}——本体模块必须导出 execute 内引用的全部类型，或去掉对模块局部辅助函数的依赖（v1 无调用桥，spec 20 §9）`,
      );
    }
  }

  assertValidDefinition(def);
  return def;
}
