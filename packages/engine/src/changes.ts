/**
 * 本体 diff —— 变更集计算（spec 60 §3 管线第一步）。
 *
 * 变更粒度：对象类型/属性/链接/struct/动作/函数，逐条恰归一档（§4）。
 * rename 在 diff 层即表现为 删+加（无重命名概念——spec 60 §4.3）。
 */
import type {
  CallableDef,
  LinkDef,
  NamedMeta,
  ObjectTypeDef,
  OntologyDefinition,
  PropertyDef,
  StructDef,
} from "@heirloom/dsl";

export type Change =
  | { kind: "add-object-type"; type: string; def: ObjectTypeDef }
  | { kind: "delete-object-type"; type: string; def: ObjectTypeDef }
  | { kind: "add-property"; type: string; prop: PropertyDef }
  | { kind: "delete-property"; type: string; prop: PropertyDef }
  | { kind: "modify-property"; type: string; from: PropertyDef; to: PropertyDef }
  | { kind: "add-link"; type: string; link: LinkDef }
  | { kind: "delete-link"; type: string; link: LinkDef }
  | { kind: "modify-link"; type: string; from: LinkDef; to: LinkDef }
  | { kind: "add-struct"; def: StructDef }
  | { kind: "delete-struct"; def: StructDef }
  | { kind: "modify-struct"; from: StructDef; to: StructDef }
  | { kind: "add-action"; def: CallableDef }
  | { kind: "delete-action"; def: CallableDef }
  | { kind: "modify-action"; from: CallableDef; to: CallableDef }
  | { kind: "add-function"; def: CallableDef }
  | { kind: "delete-function"; def: CallableDef }
  | { kind: "modify-function"; from: CallableDef; to: CallableDef }
  | { kind: "meta-change"; target: string; from: NamedMeta; to: NamedMeta };

function mapOf<T extends { apiName: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.apiName, i]));
}

/** canonical 化：排序消除声明顺序差异（no-op 判定用） */
export function canonical(def: OntologyDefinition): OntologyDefinition {
  const sortNamed = <T extends { apiName: string }>(xs: T[]) => [...xs].sort((a, b) => a.apiName.localeCompare(b.apiName));
  return {
    structs: sortNamed(def.structs).map((s) => ({ ...s, properties: sortNamed(s.properties) })),
    objectTypes: sortNamed(def.objectTypes).map((t) => ({
      ...t,
      properties: sortNamed(t.properties),
      links: sortNamed(t.links ?? []),
    })),
    actions: sortNamed(def.actions).map((a) => ({ ...a, params: Object.fromEntries(Object.entries(a.params).sort(([x], [y]) => x.localeCompare(y))) })),
    functions: sortNamed(def.functions).map((f) => ({ ...f, params: Object.fromEntries(Object.entries(f.params).sort(([x], [y]) => x.localeCompare(y))) })),
    bindings: def.bindings,
  };
}

/** 稳定序列化：递归排序全部对象键——PG jsonb 往返会重排键序，比较必须键序无关 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",") + "}";
}

export function sameDefinition(a: OntologyDefinition, b: OntologyDefinition): boolean {
  return stableStringify(canonical(a)) === stableStringify(canonical(b));
}

const META_KEYS = ["displayName", "description", "status"] as const;

function metaOnlyChange<N extends NamedMeta>(from: N, to: N): boolean {
  const pick = (x: N) => JSON.stringify(META_KEYS.map((k) => (x as Record<string, unknown>)[k]));
  return pick(from) === pick(to);
}

export function diffOntology(current: OntologyDefinition, expected: OntologyDefinition): Change[] {
  const changes: Change[] = [];
  const cur = canonical(current);
  const exp = canonical(expected);

  // ── structs（纯注册面；被引用时的形状变更由引用方属性探测承担）──
  const curStructs = mapOf(cur.structs);
  const expStructs = mapOf(exp.structs);
  for (const [name, s] of expStructs) {
    const c = curStructs.get(name);
    if (!c) changes.push({ kind: "add-struct", def: s });
    else if (stableStringify(c) !== stableStringify(s)) {
      if (metaOnlyChange(c, s) && stableStringify(s.properties) === stableStringify(c.properties)) {
        changes.push({ kind: "meta-change", target: `struct.${name}`, from: c, to: s });
      } else {
        changes.push({ kind: "modify-struct", from: c, to: s });
      }
    }
  }
  for (const [name, s] of curStructs) if (!expStructs.has(name)) changes.push({ kind: "delete-struct", def: s });

  // ── 对象类型 ──
  const curTypes = mapOf(cur.objectTypes);
  const expTypes = mapOf(exp.objectTypes);
  for (const [name, t] of expTypes) {
    const c = curTypes.get(name);
    if (!c) {
      changes.push({ kind: "add-object-type", type: name, def: t });
      // 新类型的链接另行生成 add-link（建表相位在前、加链接在后——目标表已存在）
      for (const l of t.links ?? []) changes.push({ kind: "add-link", type: name, link: l });
      continue;
    }
    // 属性
    const curProps = mapOf(c.properties);
    const expProps = mapOf(t.properties);
    for (const [pn, p] of expProps) {
      const cp = curProps.get(pn);
      if (!cp) changes.push({ kind: "add-property", type: name, prop: p });
      else if (stableStringify(cp) !== stableStringify(p)) changes.push({ kind: "modify-property", type: name, from: cp, to: p });
    }
    for (const [pn, p] of curProps) if (!expProps.has(pn)) changes.push({ kind: "delete-property", type: name, prop: p });
    // 链接
    const curLinks = mapOf(c.links ?? []);
    const expLinks = mapOf(t.links ?? []);
    for (const [ln, l] of expLinks) {
      const cl = curLinks.get(ln);
      if (!cl) changes.push({ kind: "add-link", type: name, link: l });
      else if (stableStringify(cl) !== stableStringify(l)) changes.push({ kind: "modify-link", type: name, from: cl, to: l });
    }
    for (const [ln, l] of curLinks) if (!expLinks.has(ln)) changes.push({ kind: "delete-link", type: name, link: l });
    // 类型级元数据（纯元数据变更归自动档）
    if (stableStringify({ ...c, properties: [], links: [] }) !== stableStringify({ ...t, properties: [], links: [] })) {
      changes.push({ kind: "meta-change", target: `objectType.${name}`, from: c, to: t });
    }
  }
  for (const [name, t] of curTypes) if (!expTypes.has(name)) changes.push({ kind: "delete-object-type", type: name, def: t });

  // ── 动作 / 函数（纯注册面变更，spec 60 §7）──
  for (const [label, curList, expList] of [
    ["action", cur.actions, exp.actions],
    ["function", cur.functions, exp.functions],
  ] as const) {
    const curMap = mapOf(curList as CallableDef[]);
    const expMap = mapOf(expList as CallableDef[]);
    for (const [name, d] of expMap) {
      const c = curMap.get(name);
      if (!c) changes.push({ kind: `add-${label}`, def: d } as Change);
      else if (stableStringify(c) !== stableStringify(d)) changes.push({ kind: `modify-${label}`, from: c, to: d } as Change);
    }
    for (const [name, d] of curMap) if (!expMap.has(name)) changes.push({ kind: `delete-${label}`, def: d } as Change);
  }

  return changes;
}

export function describeChange(c: Change): string {
  switch (c.kind) {
    case "add-object-type": return `objectType.${c.type} 新增`;
    case "delete-object-type": return `objectType.${c.type} 删除`;
    case "add-property": return `objectType.${c.type}.${c.prop.apiName} 新增`;
    case "delete-property": return `objectType.${c.type}.${c.prop.apiName} 删除`;
    case "modify-property": return `objectType.${c.type}.${c.to.apiName} 变更`;
    case "add-link": return `objectType.${c.type}.${c.link.apiName} 链接新增`;
    case "delete-link": return `objectType.${c.type}.${c.link.apiName} 链接删除`;
    case "modify-link": return `objectType.${c.type}.${c.to.apiName} 链接变更`;
    case "add-struct": return `struct.${c.def.apiName} 新增`;
    case "delete-struct": return `struct.${c.def.apiName} 删除`;
    case "modify-struct": return `struct.${c.to.apiName} 变更`;
    case "add-action": return `action.${c.def.apiName} 新增`;
    case "delete-action": return `action.${c.def.apiName} 删除`;
    case "modify-action": return `action.${c.to.apiName} 变更`;
    case "add-function": return `function.${c.def.apiName} 新增`;
    case "delete-function": return `function.${c.def.apiName} 删除`;
    case "modify-function": return `function.${c.to.apiName} 变更`;
    case "meta-change": return `${c.target} 元数据变更`;
  }
}
