/**
 * 自由标识符提取 —— execute 源文本的静态分析（spec 60 §7 联动校验的客户端半边）。
 *
 * 服务端在 push 时用同一函数做权威校验：自由变量必须落在
 * （定义 bindings ∪ DSL 绑定名 ∪ EXECUTE_GLOBALS）内，悬空即拒。
 * acorn 产出 ESTree AST；自实现轻量作用域跟踪（函数参数/声明/解构/catch）。
 */
import * as acorn from "acorn";
import { DSL_BINDING_NAMES, EXECUTE_GLOBALS } from "./definition.js";

type Node = acorn.Node & { [k: string]: any };

interface Scope {
  vars: Set<string>;
  parent: Scope | null;
}

function collectPattern(node: Node | null | undefined, scope: Scope): void {
  if (!node) return;
  switch (node.type) {
    case "Identifier":
      scope.vars.add(node.name);
      break;
    case "RestElement":
      collectPattern(node.argument, scope);
      break;
    case "AssignmentPattern":
      collectPattern(node.left, scope);
      break;
    case "ArrayPattern":
      for (const el of node.elements) collectPattern(el, scope);
      break;
    case "ObjectPattern": {
      for (const prop of node.properties) {
        if (prop.type === "RestElement") collectPattern(prop.argument, scope);
        else collectPattern(prop.value, scope);
      }
      break;
    }
    case "MemberExpression":
      // 解构目标位出现成员表达式（a.b = c 形参默认）——只收对象根的引用
      break;
    default:
      break;
  }
}

function declareScopeVars(node: Node, scope: Scope): void {
  switch (node.type) {
    case "VariableDeclaration":
      for (const decl of node.declarations) collectPattern(decl.id, scope);
      break;
    case "FunctionDeclaration":
      if (node.id) scope.vars.add(node.id.name);
      break;
    case "ClassDeclaration":
      if (node.id) scope.vars.add(node.id.name);
      break;
    case "CatchClause":
      // try/catch 参数按函数作用域近似（块级差异不影响自由变量判定）
      if (node.param) collectPattern(node.param, scope);
      break;
    default:
      break;
  }
}

function isFunctionLike(node: Node): boolean {
  return (
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

function newFunctionScope(node: Node, parent: Scope | null): Scope {
  const scope: Scope = { vars: new Set(), parent };
  if (node.type !== "ArrowFunctionExpression") {
    // 箭头函数无自身 this/arguments 绑定，但参数与新声明照常遮蔽
  }
  for (const p of node.params ?? []) collectPattern(p, scope);
  return scope;
}

/** 提取源文本中的自由标识符（引用位出现且无局部绑定者） */
export function extractFreeIdentifiers(source: string): Set<string> {
  const ast = acorn.parse(`(${source})`, { ecmaVersion: "latest" }) as Node;
  const free = new Set<string>();

  function resolve(name: string, scope: Scope | null): boolean {
    let s = scope;
    while (s) {
      if (s.vars.has(name)) return true;
      s = s.parent;
    }
    return false;
  }

  function walk(node: unknown, scope: Scope | null): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, scope);
      return;
    }
    if (typeof (node as Node).type !== "string") return;
    const n = node as Node;

    // 声明进当前作用域（函数声明先登记再走函数体，允许递归）
    declareScopeVars(n, scope ?? { vars: new Set(), parent: null });

    if (isFunctionLike(n)) {
      const inner = newFunctionScope(n, scope);
      if (n.id) inner.vars.add(n.id.name); // 函数名自引用（具名函数表达式）
      walk(n.body, inner);
      return;
    }
    if (n.type === "BlockStatement") {
      const block: Scope = { vars: new Set(), parent: scope };
      for (const stmt of n.body) declareScopeVars(stmt, block);
      walk(n.body, block);
      return;
    }
    if (n.type === "Identifier") {
      if (scope && !resolve(n.name, scope)) free.add(n.name);
      else if (!scope) free.add(n.name);
      return;
    }
    if (n.type === "MemberExpression") {
      // 只走对象根；属性名（非计算）不是引用
      walk(n.object, scope);
      if (n.computed) walk(n.property, scope);
      return;
    }
    if (n.type === "Property") {
      // 对象字面量属性：非计算键不算引用（{ name: x } 的 name）
      walk(n.value, scope);
      if (n.computed) walk(n.key, scope);
      return;
    }
    if (n.type === "LabeledStatement") {
      walk(n.body, scope);
      return;
    }

    for (const key of Object.keys(n)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      walk((n as any)[key], scope);
    }
  }

  const arrow = (ast as any).body[0].expression as Node;
  const root = newFunctionScope(arrow, null);
  walk(arrow.body, root);
  return free;
}

export function isDslBindingName(name: string): boolean {
  return (DSL_BINDING_NAMES as readonly string[]).includes(name);
}

export function isAllowedGlobal(name: string): boolean {
  return EXECUTE_GLOBALS.has(name);
}

/** 校验自由标识符：返回悬空名单（空集 = 通过）。bindings 来自定义 JSON。 */
export function findDanglingIdentifiers(
  source: string,
  bindings: Record<string, unknown>,
): { dangling: string[]; free: string[] } {
  // 测试环境 SSR 变换噪声（__vite_ssr_import_N__）：非真实悬空引用
  const ENV_NOISE = /^__vite_ssr_import_\d+__$/;
  const free = [...extractFreeIdentifiers(source)].filter((n) => !ENV_NOISE.test(n));
  const dangling = free.filter(
    (name) => !(name in bindings) && !isDslBindingName(name) && !isAllowedGlobal(name),
  );
  return { dangling, free };
}
