/**
 * 变更三档分类（spec 60 §4 矩阵——normative）。
 *
 * 自动档 = DDL 即时无存量依赖；数据校验档 = 尝试执行、存量不过即拒；
 * 拒绝档 = 不得自动安全化（出路 = 三通道，spec 60 §5）。
 */
import type { PropertyDef } from "@heirloom/dsl";
import type { Change } from "./changes.js";

export type Tier = "auto" | "data-validation" | "breaking";

export interface ClassifiedChange {
  change: Change;
  tier: Tier;
  /** breaking 必带出路建议（spec 30 §4.1）；enum 删值存量命中等探测升级场景运行期填充 */
  remedy?: string;
}

const REMEDY_ACTION = "分多次 push：加新属性(自动) → 一次性动作搬值 → 删旧属性（spec 60 §5 三通道之一）";
const REMEDY_REINGEST = "删类型 → 接入端点重灌（spec 60 §5）";
const REMEDY_DEFAULT = "带静态 default 重推，或先经一次性动作回填再收紧";
export { REMEDY_ACTION, REMEDY_REINGEST, REMEDY_DEFAULT };

/** decimal 字符串数值比较（scale 对齐后比 BigInt） */
function cmpDecimal(a: string | number, b: string | number): number {
  const sa = String(a).split(".");
  const sb = String(b).split(".");
  const scale = Math.max(sa[1]?.length ?? 0, sb[1]?.length ?? 0);
  const na = BigInt(sa[0] + (sa[1] ?? "").padEnd(scale, "0"));
  const nb = BigInt(sb[0] + (sb[1] ?? "").padEnd(scale, "0"));
  return na < nb ? -1 : na > nb ? 1 : 0;
}

function staticDefault(p: PropertyDef): unknown | undefined {
  return p.default?.kind === "static" ? p.default.value : undefined;
}

function boundsLoosened(
  from: { min?: number | string; max?: number | string } | undefined,
  to: { min?: number | string; max?: number | string } | undefined,
  decimal: boolean,
): boolean {
  if (!from) return true; // 无 → 有：放宽为「有界」？收紧——保守按收紧（DV 校验存量）
  if (!to) return true; // 有 → 无：放宽
  const cmp = decimal ? cmpDecimal : (a: number | string, b: number | string) => Math.sign(Number(a) - Number(b));
  if (from.min !== undefined && to.min !== undefined && cmp(to.min, from.min) < 0) return true;
  if (from.max !== undefined && to.max !== undefined && cmp(to.max, from.max) > 0) return true;
  // min/max 出现或消失的其它组合：保守按收紧
  if (from.min === undefined && to.min !== undefined) return false;
  if (from.max === undefined && to.max !== undefined) return false;
  if (from.min !== undefined && to.min === undefined) return true;
  if (from.max !== undefined && to.max === undefined) return true;
  return false;
}

function lengthLoosened(from: PropertyDef, to: PropertyDef): boolean {
  const f = from.length;
  const t = to.length;
  if (!f && !t) return true;
  if (!t) return true;
  if (!f) return false;
  if (t.min !== undefined && f.min !== undefined && t.min < f.min) return true;
  if (t.max !== undefined && f.max !== undefined && t.max > f.max) return true;
  if (f.min !== undefined && t.min === undefined) return true;
  if (f.max !== undefined && t.max === undefined) return true;
  return false;
}

export function classifyChange(change: Change): ClassifiedChange {
  const wrap = (tier: Tier, remedy?: string): ClassifiedChange => ({ change, tier, remedy });

  switch (change.kind) {
    case "add-object-type":
    case "add-struct":
    case "add-action":
    case "add-function":
    case "delete-action":
    case "delete-function":
    case "modify-action":
    case "modify-function":
    case "meta-change":
      return wrap("auto");

    case "delete-object-type":
      return wrap("data-validation"); // 删空探测：表行数 = 0

    case "delete-struct":
      // 被 properties 引用已被定义校验拒绝；纯未引用 → 注册面删除
      return wrap("auto");

    case "modify-struct":
      return wrap("data-validation"); // 引用方存量 jsonb 形状校验

    case "add-property": {
      const p = change.prop;
      if (!p.required) return wrap("auto"); // ADD COLUMN 可空
      if (staticDefault(p) !== undefined) return wrap("data-validation"); // PG11+ 元数据-only 回填
      return wrap("breaking", REMEDY_DEFAULT);
    }

    case "delete-property":
      return wrap("data-validation"); // 探测：该列非 NULL 计数 = 0

    case "delete-link":
      return wrap("data-validation"); // 探测：非空链接计数 = 0

    case "add-link": {
      if (change.link.required) return wrap("data-validation"); // 存量对象须已全部链接（探测）
      return wrap("auto"); // 可空 FK 列 / 新链接表
    }

    case "modify-link": {
      const { from, to } = change;
      if (from.target !== to.target || from.cardinality !== to.cardinality) {
        return wrap("breaking", "链接目标/基数变更 = 删链接 + 加链接" + REMEDY_ACTION);
      }
      if (!from.required && to.required) return wrap("data-validation"); // 存量须已全部链接
      if (from.required && !to.required) return wrap("auto"); // DROP NOT NULL
      return wrap("auto"); // 纯元数据/反向名
    }

    case "modify-property": {
      const { from, to } = change;

      // 标量类型变更（含数组元素类型，type 字符串含 []）→ 拒绝档
      if (from.type !== to.type) return wrap("breaking", "改标量类型：" + REMEDY_ACTION);

      const arrayChanged = JSON.stringify(from.array?.element) !== JSON.stringify(to.array?.element);
      if (arrayChanged) {
        // 元素约束变化：放宽=auto，其余=DV；元素类型变化已在 type 比较覆盖（type 含 []）
        const elFrom = from.array?.element ?? {};
        const elTo = to.array?.element ?? {};
        const elTightened =
          JSON.stringify(elFrom) !== JSON.stringify(elTo) &&
          !boundsLoosened((elFrom as any).range, (elTo as any).range, (elTo as any).type === "decimal") &&
          !lengthLoosened({ length: (elFrom as any).length } as PropertyDef, { length: (elTo as any).length } as PropertyDef);
        return wrap(elTightened ? "data-validation" : "auto");
      }

      // required 收紧
      if (!from.required && to.required) {
        if (staticDefault(to) !== undefined) return wrap("data-validation");
        return wrap("breaking", "可选 → required 无 default" + REMEDY_DEFAULT);
      }
      // required 放宽 → auto（DROP NOT NULL）

      // unique
      if (!from.unique && to.unique) return wrap("data-validation"); // 建索引扫存量
      // unique 取消 → auto（drop index）

      // range / length
      const decimal = from.type === "decimal";
      if (JSON.stringify(from.range) !== JSON.stringify(to.range)) {
        return wrap(boundsLoosened(from.range, to.range, decimal) ? "auto" : "data-validation");
      }
      if (JSON.stringify(from.length) !== JSON.stringify(to.length)) {
        return wrap(lengthLoosened(from, to) ? "auto" : "data-validation");
      }

      // regex：不可判定方向 → 一律 DV（新 CHECK 校验存量）
      if (JSON.stringify(from.regex) !== JSON.stringify(to.regex)) return wrap("data-validation");

      // enum 值集
      if (JSON.stringify(from.values) !== JSON.stringify(to.values)) {
        const removed = (from.values ?? []).filter((v) => !(to.values ?? []).includes(v));
        if (removed.length === 0) return wrap("auto"); // 纯加值 = 超集
        return wrap("data-validation", undefined); // 删值：探测引用，命中升级 breaking（push 执行期）
      }

      // struct 形状变化（同 struct apiName 被改）→ 由 modify-struct 承担；此处为 struct 引用替换
      if (from.struct !== to.struct) return wrap("data-validation");

      // default 增删改（静态字面量）→ 列 DEFAULT 元数据，auto
      return wrap("auto");
    }
  }
}

export function classifyAll(changes: Change[]): ClassifiedChange[] {
  return changes.map(classifyChange);
}
