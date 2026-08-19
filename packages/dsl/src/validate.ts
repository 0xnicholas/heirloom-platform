/**
 * 定义 JSON 结构校验 —— DSL 物化后与服务端 push 前共用的权威校验
 * （spec 60 §7：定义结构校验在变更分类之前先行拒绝，400 域）。
 */
import * as acorn from "acorn";
import type {
  CallableDef,
  ElementDef,
  OntologyDefinition,
  PropertyDef,
  Status,
  StructDef,
} from "./definition.js";
import { DSL_BINDING_NAMES, EXECUTE_GLOBALS } from "./definition.js";
import { extractFreeIdentifiers } from "./free-identifiers.js";

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CAMEL = /^[a-z][a-zA-Z0-9]*$/;
const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;
const STATUSES: readonly Status[] = ["experimental", "active", "deprecated"];

const UNIQUE_OK = new Set(["string", "integer", "float", "decimal"]);
const RANGE_OK = new Set(["integer", "float", "decimal"]);
const LENGTH_OK = new Set(["string"]);
const REGEX_OK = new Set(["string"]);

export interface ValidationIssue {
  path: string;
  message: string;
}

export class DefinitionValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(`定义结构校验失败（${issues.length} 处）：\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`);
    this.name = "DefinitionValidationError";
  }
}

function checkMeta(target: { apiName: string; displayName?: string; description?: string; status?: string }, nameKind: "kebab" | "camel", path: string, issues: ValidationIssue[]): void {
  const re = nameKind === "kebab" ? KEBAB : CAMEL;
  if (!target.apiName || !re.test(target.apiName)) {
    issues.push({ path: `${path}.apiName`, message: `"${target.apiName}" 不符合 ${nameKind} 命名规则（spec 10 §1）` });
  }
  if (!target.displayName || typeof target.displayName !== "string") {
    issues.push({ path: `${path}.displayName`, message: "displayName 必填（spec 10 §1）" });
  }
  if (target.status && !STATUSES.includes(target.status as Status)) {
    issues.push({ path: `${path}.status`, message: `status 必须为 ${STATUSES.join("/")}` });
  }
}

function checkElement(el: ElementDef | undefined, path: string, issues: ValidationIssue[]): void {
  if (!el) return;
  const known = ["string", "boolean", "integer", "float", "decimal", "date", "datetime", "enum", "json", "struct"];
  if (!known.includes(el.type)) {
    issues.push({ path: `${path}.element.type`, message: `未知元素类型 ${el.type}` });
    return;
  }
  if (el.type === "enum") {
    if (!el.values || el.values.length === 0) issues.push({ path: `${path}.element.values`, message: "enum 值集不得为空" });
  }
  if (el.type === "struct" && !el.struct) {
    issues.push({ path: `${path}.element.struct`, message: "struct 元素必须携带 struct apiName" });
  }
}

function checkProperty(prop: PropertyDef, path: string, issues: ValidationIssue[], inParams: boolean): void {
  checkMeta(prop, "camel", path, issues);

  const hasArray = !!prop.array;
  const baseType = prop.target ? "ref" : prop.struct ? "struct" : (prop.values ? "enum" : undefined);

  if (prop.target) {
    if (!inParams) {
      issues.push({ path: `${path}`, message: "对象引用（ref）只能用于动作/函数参数，不得作为类型属性（spec 10 §3.1）" });
    }
    if (hasArray) issues.push({ path: `${path}`, message: "ref 参数不得为数组（对象集输入 → 查询/函数层）" });
    return;
  }

  if (hasArray) {
    checkElement(prop.array?.element, path, issues);
    // 数组层：length=数组长度；元素约束按元素类型适配
    return;
  }

  if (baseType === "struct") {
    if (!prop.struct) issues.push({ path: `${path}.struct`, message: "struct 属性必须携带 struct apiName" });
    if (prop.unique) issues.push({ path: `${path}.unique`, message: "struct 属性不得声明 unique（约束适配表，spec 10 §3）" });
    return;
  }

  if (baseType === "enum") {
    if (!prop.values || prop.values.length === 0) {
      issues.push({ path: `${path}.values`, message: "enum 值集不得为空" });
    }
    if (new Set(prop.values ?? []).size !== (prop.values ?? []).length) {
      issues.push({ path: `${path}.values`, message: "enum 值集不得重复" });
    }
    if (prop.unique) issues.push({ path: `${path}.unique`, message: "enum 属性不得声明 unique（约束适配表）" });
    return;
  }

  if (prop.type === "json") {
    if (prop.unique || prop.length || prop.range || prop.regex) {
      issues.push({ path: `${path}`, message: "json 逃生舱无约束、无索引、无过滤（spec 10 §3）" });
    }
    return;
  }

  // 标量约束适配（spec 10 §3 表）
  if (prop.unique && !UNIQUE_OK.has(prop.type)) {
    issues.push({ path: `${path}.unique`, message: `${prop.type} 属性不支持 unique` });
  }
  if (prop.range && !RANGE_OK.has(prop.type)) {
    issues.push({ path: `${path}.range`, message: `${prop.type} 属性不支持 range` });
  }
  if (prop.length && !LENGTH_OK.has(prop.type)) {
    issues.push({ path: `${path}.length`, message: `${prop.type} 属性不支持 length` });
  }
  if (prop.regex && !REGEX_OK.has(prop.type)) {
    issues.push({ path: `${path}.regex`, message: `${prop.type} 属性不支持 regex` });
  }
  if (prop.type === "decimal") {
    for (const [k, v] of Object.entries(prop.range ?? {})) {
      if (typeof v === "string" && !DECIMAL_RE.test(v)) {
        issues.push({ path: `${path}.range.${k}`, message: `decimal range 边界 "${v}" 不是合法十进制文法` });
      }
    }
  }
}

function checkStaticDefaultType(prop: PropertyDef, path: string, issues: ValidationIssue[]): void {
  const def = prop.default;
  if (!def || def.kind !== "static") return;
  const v = def.value;
  const typeOf = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  const ok =
    prop.array
      ? Array.isArray(v)
      : prop.type === "string" || prop.type === "date" || prop.type === "datetime" || prop.type === "decimal" || prop.type === "enum"
        ? typeOf === "string"
        : prop.type === "integer" || prop.type === "float"
          ? typeOf === "number" && Number.isInteger(v) === (prop.type === "integer")
          : prop.type === "boolean"
            ? typeOf === "boolean"
            : prop.type === "json"
              ? true
              : true;
  if (!ok) {
    issues.push({ path: `${path}.default`, message: `静态默认值类型（${typeOf}）与属性类型（${prop.array ? "array" : prop.type}）不符` });
  }
  if (prop.type === "decimal" && typeof v === "string" && !DECIMAL_RE.test(v)) {
    issues.push({ path: `${path}.default`, message: `decimal 默认值 "${v}" 不是合法十进制文法` });
  }
}

/** struct 嵌套深度（≤2 层，spec 10 §2）与环检测 */
function structDepth(apiName: string, structs: Map<string, StructDef>, seen: Set<string>, path: string, issues: ValidationIssue[]): number {
  if (seen.has(apiName)) {
    issues.push({ path, message: `struct 嵌套成环：${[...seen, apiName].join(" → ")}` });
    return 0;
  }
  const def = structs.get(apiName);
  if (!def) return 0;
  seen.add(apiName);
  let depth = 1;
  for (const prop of def.properties) {
    if (prop.struct) {
      depth = Math.max(depth, 1 + structDepth(prop.struct, structs, seen, `${path}.${prop.apiName}`, issues));
    }
  }
  seen.delete(apiName);
  return depth;
}

export function validateDefinition(def: OntologyDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const objectNames = new Set(def.objectTypes.map((t) => t.apiName));
  const structNames = new Set(def.structs.map((s) => s.apiName));

  // 命名空间：对象类型与 struct 共享（同层互斥）
  for (const name of structNames) {
    if (objectNames.has(name)) issues.push({ path: `struct.${name}`, message: "apiName 与对象类型冲突" });
  }

  for (const s of def.structs) {
    checkMeta(s, "camel", `struct.${s.apiName}`, issues);
    const seen = new Set<string>([s.apiName]);
    for (const prop of s.properties) {
      checkProperty(prop, `struct.${s.apiName}.${prop.apiName}`, issues, false);
      checkStaticDefaultType(prop, `struct.${s.apiName}.${prop.apiName}`, issues);
      if (prop.target) {
        issues.push({ path: `struct.${s.apiName}.${prop.apiName}`, message: "struct 内不得使用 ref" });
      }
      if (prop.struct) {
        if (!structNames.has(prop.struct) || prop.struct === s.apiName) {
          issues.push({ path: `struct.${s.apiName}.${prop.apiName}`, message: `引用的 struct 不存在：${prop.struct}` });
        } else {
          const depth = structDepth(prop.struct, new Map(def.structs.map((x) => [x.apiName, x])), seen, `struct.${s.apiName}.${prop.apiName}`, issues);
          if (1 + depth > 2) {
            issues.push({ path: `struct.${s.apiName}.${prop.apiName}`, message: "struct 嵌套不得超过两层（spec 10 §2）" });
          }
        }
      }
    }
  }

  const linkReverseSeen = new Map<string, string[]>(); // `${target}|${reverse}` → [declarer#linkName]
  for (const t of def.objectTypes) {
    checkMeta(t, "kebab", `objectType.${t.apiName}`, issues);
    const propNames = new Set<string>();
    for (const prop of t.properties) {
      if (propNames.has(prop.apiName)) issues.push({ path: `objectType.${t.apiName}`, message: `属性名重复：${prop.apiName}` });
      propNames.add(prop.apiName);
      checkProperty(prop, `objectType.${t.apiName}.${prop.apiName}`, issues, false);
      checkStaticDefaultType(prop, `objectType.${t.apiName}.${prop.apiName}`, issues);
      if (prop.struct && !structNames.has(prop.struct)) {
        issues.push({ path: `objectType.${t.apiName}.${prop.apiName}`, message: `引用的 struct 不存在：${prop.struct}` });
      }
    }
    const linkNames = new Set<string>(t.properties.map((p) => p.apiName));
    for (const l of t.links ?? []) {
      if (linkNames.has(l.apiName)) {
        issues.push({ path: `objectType.${t.apiName}.${l.apiName}`, message: "链接名与属性名冲突" });
      }
      linkNames.add(l.apiName);
      checkMeta(l, "camel", `objectType.${t.apiName}.${l.apiName}`, issues);
      if (!objectNames.has(l.target)) {
        issues.push({ path: `objectType.${t.apiName}.${l.apiName}.target`, message: `链接目标类型不存在：${l.target}` });
      }
      if (!l.reverse || !CAMEL.test(l.reverse)) {
        issues.push({ path: `objectType.${t.apiName}.${l.apiName}.reverse`, message: "反向名必须为 camelCase" });
      }
      const key = `${l.target}|${l.reverse}`;
      const prior = linkReverseSeen.get(key) ?? [];
      prior.push(`${t.apiName}#${l.apiName}`);
      linkReverseSeen.set(key, prior);
    }
  }
  // 同型双链接同名反向名 → 拒（spec 10 §4 派生规则）
  for (const [key, declarers] of linkReverseSeen) {
    if (declarers.length > 1) {
      issues.push({
        path: `link.reverse[${key}]`,
        message: `反向名 "${key.split("|")[1]!}" 被 ${declarers.length} 条链接共用（${declarers.join(", ")}）——须显式命名以消歧（spec 10 §4）`,
      });
    }
  }

  const callableNames = new Set<string>();
  const checkCallable = (c: CallableDef, kind: "action" | "function") => {
    checkMeta(c, "kebab", `${kind}.${c.apiName}`, issues);
    if (callableNames.has(c.apiName)) issues.push({ path: `${kind}.${c.apiName}`, message: "动作/函数 apiName 冲突" });
    callableNames.add(c.apiName);
    for (const [name, param] of Object.entries(c.params)) {
      checkProperty(param, `${kind}.${c.apiName}.${name}`, issues, true);
      checkStaticDefaultType(param, `${kind}.${c.apiName}.${name}`, issues);
      if (param.target && !objectNames.has(param.target)) {
        issues.push({ path: `${kind}.${c.apiName}.${name}.target`, message: `ref 目标类型不存在：${param.target}` });
      }
    }
    if (!c.executeSource || typeof c.executeSource !== "string") {
      issues.push({ path: `${kind}.${c.apiName}.executeSource`, message: "execute 源文本必须存在" });
      return;
    }
    try {
      acorn.parse(`(${c.executeSource})`, { ecmaVersion: "latest" });
    } catch (e) {
      issues.push({ path: `${kind}.${c.apiName}.executeSource`, message: `非合法 JS 源文本（TS 注解须在物化前剥除）：${(e as Error).message}` });
      return;
    }
    // 联动校验：自由变量悬空 → 拒（服务端权威，spec 60 §7）
    const ENV_NOISE = /^__vite_ssr_import_\d+__$/; // 测试环境 SSR 变换噪声
    const free = [...extractFreeIdentifiers(c.executeSource)].filter((n) => !ENV_NOISE.test(n));
    const bindingNames = new Set([...Object.keys(def.bindings ?? {}), ...DSL_BINDING_NAMES, ...EXECUTE_GLOBALS]);
    const dangling = [...free].filter((n) => !bindingNames.has(n));
    if (dangling.length > 0) {
      issues.push({
        path: `${kind}.${c.apiName}.executeSource`,
        message: `悬空引用（须为本体模块导出或 DSL 绑定）：${dangling.join(", ")}`,
      });
    }
  };
  for (const a of def.actions) checkCallable(a, "action");
  for (const f of def.functions) checkCallable(f, "function");

  return issues;
}

export function assertValidDefinition(def: OntologyDefinition): void {
  const issues = validateDefinition(def);
  if (issues.length > 0) throw new DefinitionValidationError(issues);
}
