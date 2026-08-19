/**
 * DDL 生成 —— 本体 → 物理 schema（spec 40 §2/§3 映射基线）。
 *
 * 约束一律由 Postgres 原生承担：required→NOT NULL、length/range/regex→CHECK、
 * unique→UNIQUE、enum→CHECK IN；1:1/1:N → N 侧 FK 列（1:1 加 UNIQUE）；
 * M:N → 链接表 (from,to) 主键。数组元素级约束无法用 CHECK 表达（无子查询），
 * 由写通道应用层校验（已知限制，随实现文档化）。
 */
import type { LinkDef, ObjectTypeDef, PropertyDef, StructDef } from "@heirloom/dsl";
import { type ClassifiedChange, REMEDY_DEFAULT } from "./classify.js";
import {
  checkName,
  columnName,
  fkName,
  linkTable,
  objectTable,
  quoteIdent,
  sqlString,
  tableName,
  uniqueName,
  ONTOLOGY_SCHEMA,
} from "./naming.js";

export interface SqlOp {
  type: "sql";
  sql: string;
  description: string;
}

export interface ProbeOp {
  type: "probe";
  /** 单值查询：计数/命中数；> 0 即违例 */
  sql: string;
  description: string;
  /** 违例时升格为拒绝档（enum 删值有引用，spec 60 §4.3） */
  escalateBreaking?: boolean;
  /** 违例归属的变更描述 */
  violation: string;
  remedy?: string;
}

export type Op = SqlOp | ProbeOp;

const sysCols = [
  `id uuid PRIMARY KEY`,
  `created_at timestamptz NOT NULL DEFAULT now()`,
  `updated_at timestamptz NOT NULL DEFAULT now()`,
];

function pgType(prop: PropertyDef): { type: string; checks: string[] } {
  const checks: string[] = [];
  if (prop.array) {
    const el = prop.array.element;
    const t =
      el.type === "string" || el.type === "enum"
        ? "text[]"
        : el.type === "integer"
          ? "bigint[]"
          : el.type === "float"
            ? "double precision[]"
            : el.type === "decimal"
              ? "numeric[]"
              : el.type === "boolean"
                ? "boolean[]"
                : el.type === "date"
                  ? "date[]"
                  : el.type === "datetime"
                    ? "timestamptz[]"
                    : el.type === "struct"
                      ? "jsonb"
                      : "text[]";
    if (prop.array.length) {
      const lo = prop.array.length.min ?? 0;
      const hi = prop.array.length.max;
      checks.push(
        `array_length(${quoteIdent(columnName(prop.apiName))}, 1) IS NULL OR (array_length(${quoteIdent(columnName(prop.apiName))}, 1) >= ${lo}${hi !== undefined ? ` AND array_length(${quoteIdent(columnName(prop.apiName))}, 1) <= ${hi}` : ""})`,
      );
    }
    return { type: t, checks };
  }
  switch (prop.type) {
    case "string": return { type: "text", checks };
    case "boolean": return { type: "boolean", checks };
    case "integer": return { type: "bigint", checks };
    case "float": return { type: "double precision", checks };
    case "decimal": return { type: "numeric", checks };
    case "date": return { type: "date", checks };
    case "datetime": return { type: "timestamptz", checks };
    case "json": return { type: "jsonb", checks };
    case "struct": return { type: "jsonb", checks };
    case "enum":
      return {
        type: "text",
        checks: [`${quoteIdent(columnName(prop.apiName))} IN (${(prop.values ?? []).map(sqlString).join(", ")})`],
      };
    default: return { type: "text", checks };
  }
}

function rangeCheck(prop: PropertyDef): string[] {
  if (!prop.range) return [];
  const col = quoteIdent(columnName(prop.apiName));
  const toLiteral = (v: number | string) => (typeof v === "number" ? String(v) : sqlString(v));
  const out: string[] = [];
  if (prop.range.min !== undefined) out.push(`${col} >= ${toLiteral(prop.range.min)}`);
  if (prop.range.max !== undefined) out.push(`${col} <= ${toLiteral(prop.range.max)}`);
  return out;
}

function lengthCheck(prop: PropertyDef): string[] {
  if (!prop.length) return [];
  const col = quoteIdent(columnName(prop.apiName));
  const out: string[] = [];
  if (prop.length.min !== undefined) out.push(`char_length(${col}) >= ${prop.length.min}`);
  if (prop.length.max !== undefined) out.push(`char_length(${col}) <= ${prop.length.max}`);
  return out;
}

function regexCheck(prop: PropertyDef): string[] {
  if (!prop.regex) return [];
  const flags = prop.regex.flags ?? "";
  // PG 正则：无斜杠包裹；i → ~*（大小写不敏感）；m → 内嵌 (?m)；其余标志忽略（实现注记）
  let pattern = prop.regex.source.replace(/'/g, "''");
  if (flags.includes("m")) pattern = `(?m)${pattern}`;
  const op = flags.includes("i") ? `~*` : `~`;
  return [`${quoteIdent(columnName(prop.apiName))} ${op} '${pattern}'`];
}

/** 属性的 CHECK 子句（不含 enum 值集——在 pgType 内） */
function scalarChecks(prop: PropertyDef): string[] {
  if (prop.array) return [];
  return [...rangeCheck(prop), ...lengthCheck(prop), ...regexCheck(prop)];
}

export function createTableStatements(def: ObjectTypeDef): Op[] {
  const table = tableName(def.apiName);
  const cols = [...sysCols];
  const constraints: string[] = [];
  for (const prop of def.properties) {
    const { type, checks } = pgType(prop);
    const parts = [quoteIdent(columnName(prop.apiName)), type];
    if (prop.required) parts.push("NOT NULL");
    if (prop.default?.kind === "static") parts.push(`DEFAULT ${literal(prop.default.value)}`);
    cols.push(parts.join(" "));
    const all = [...checks, ...scalarChecks(prop)];
    if (all.length > 0) constraints.push(`CONSTRAINT ${checkName(table, columnName(prop.apiName))} CHECK (${quoteIdent(columnName(prop.apiName))} IS NULL OR (${all.join(" AND ")}))`);
    if (prop.unique) {
      constraints.push(`CONSTRAINT ${uniqueName(table, columnName(prop.apiName))} UNIQUE (${quoteIdent(columnName(prop.apiName))})`);
    }
  }
  const ddl = `CREATE TABLE ${objectTable(def.apiName)} (\n  ${cols.join(",\n  ")}${constraints.length ? ",\n  " + constraints.join(",\n  ") : ""}\n)`;
  return [{ type: "sql", sql: ddl, description: `建表 ${def.apiName}` }];
}

/** 链接的物理落位：FK 侧表/列 或 M:N 链接表 */
type LinkPhysical =
  | {
      mode: "fk";
      fkTable: string; // apiName
      fkColumn: string; // 逻辑链接名（列语义）
      fkColumnSnake: string; // 物理列名（含 _id）
      unique: boolean;
      required: boolean;
      references: string;
    }
  | { mode: "mn"; declarer: string; linkName: string; target: string };

export function linkPhysical(link: LinkDef, declarer: string): LinkPhysical {
  switch (link.cardinality) {
    case "many-to-one":
      return { mode: "fk", fkTable: declarer, fkColumnSnake: `${columnName(link.apiName)}_id`, unique: false, required: link.required, references: link.target, fkColumn: link.apiName };
    case "one-to-one":
      // 声明方持 FK + UNIQUE
      return { mode: "fk", fkTable: declarer, fkColumnSnake: `${columnName(link.apiName)}_id`, unique: true, required: link.required, references: link.target, fkColumn: link.apiName };
    case "one-to-many":
      // 目标方（N 侧）持 FK，列名按反向名
      return { mode: "fk", fkTable: link.target, fkColumnSnake: `${columnName(link.reverse)}_id`, unique: false, required: false, references: declarer, fkColumn: link.reverse };
    case "many-to-many":
      return { mode: "mn", declarer, linkName: link.apiName, target: link.target };
  }
}

export function addLinkOps(link: LinkDef, declarer: string): Op[] {
  const phys = linkPhysical(link, declarer);
  if (phys.mode === "mn") {
    const lt = linkTable(declarer, link.apiName);
    return [
      {
        type: "sql",
        sql: `CREATE TABLE ${lt} (
  ${quoteIdent("from_id")} uuid NOT NULL REFERENCES ${objectTable(declarer)} (${quoteIdent("id")}) ON DELETE CASCADE,
  ${quoteIdent("to_id")} uuid NOT NULL REFERENCES ${objectTable(phys.target)} (${quoteIdent("id")}) ON DELETE CASCADE,
  PRIMARY KEY (${quoteIdent("from_id")}, ${quoteIdent("to_id")})
)`,
        description: `M:N 链接表 ${declarer}.${link.apiName}`,
      },
    ];
  }
  const table = tableName(phys.fkTable);
  const col = phys.fkColumnSnake;
  const ops: Op[] = [
    { type: "sql", sql: `ALTER TABLE ${objectTable(phys.fkTable)} ADD COLUMN ${quoteIdent(col)} uuid`, description: `${phys.fkTable}.${col} FK 列` },
    { type: "sql", sql: `ALTER TABLE ${objectTable(phys.fkTable)} ADD CONSTRAINT ${fkName(table, col)} FOREIGN KEY (${quoteIdent(col)}) REFERENCES ${objectTable(phys.references)} (${quoteIdent("id")})`, description: `FK ${table}.${col} → ${phys.references}` },
  ];
  if (phys.unique) {
    ops.push({ type: "sql", sql: `ALTER TABLE ${objectTable(phys.fkTable)} ADD CONSTRAINT ${uniqueName(table, col)} UNIQUE (${quoteIdent(col)})`, description: `1:1 UNIQUE ${table}.${col}` });
  }
  if (phys.required) {
    // 先探测存量未链接行（=0 才可 NOT NULL）；新表空表自然通过
    ops.push({
      type: "probe",
      sql: `SELECT count(*)::int AS n FROM ${objectTable(phys.fkTable)} WHERE ${quoteIdent(col)} IS NULL`,
      description: `${phys.fkTable}.${col} required 探测`,
      violation: `加 required 链接 ${declarer}.${link.apiName}：存量存在未链接对象`,
      remedy: "先解除存量对象或分批回填后再收紧",
    });
    ops.push({ type: "sql", sql: `ALTER TABLE ${objectTable(phys.fkTable)} ALTER COLUMN ${quoteIdent(col)} SET NOT NULL`, description: `${phys.fkTable}.${col} NOT NULL` });
  }
  return ops;
}

export function deleteLinkOps(link: LinkDef, declarer: string): Op[] {
  const phys = linkPhysical(link, declarer);
  if (phys.mode === "mn") {
    const lt = linkTable(declarer, link.apiName);
    return [
      { type: "probe", sql: `SELECT count(*)::int AS n FROM ${lt}`, description: `${declarer}.${link.apiName} 链接表空探测`, violation: `删链接 ${declarer}.${link.apiName}：链接表非空`, remedy: "先清链接（unlink 或删对象）" },
      { type: "sql", sql: `DROP TABLE ${lt}`, description: `删链接表 ${declarer}.${link.apiName}` },
    ];
  }
  const col = phys.fkColumnSnake;
  return [
    { type: "probe", sql: `SELECT count(*)::int AS n FROM ${objectTable(phys.fkTable)} WHERE ${quoteIdent(col)} IS NOT NULL`, description: `${phys.fkTable}.${col} 空探测`, violation: `删链接 ${declarer}.${link.apiName}：存在非空链接`, remedy: "先清链接（unlink 或删对象）" },
    { type: "sql", sql: `ALTER TABLE ${objectTable(phys.fkTable)} DROP COLUMN ${quoteIdent(col)}`, description: `删 FK 列 ${phys.fkTable}.${col}` },
  ];
}

/** 变更 → 操作序列（DDL + 探测交错；探测失败即整事务拒绝） */
export function buildOps(cc: ClassifiedChange, structs: StructDef[]): Op[] {
  const c = cc.change;
  switch (c.kind) {
    case "add-object-type":
      return createTableStatements(c.def);
    case "delete-object-type":
      return [
        { type: "probe", sql: `SELECT count(*)::int AS n FROM ${objectTable(c.type)}`, description: `${c.type} 空表探测`, violation: `删类型 ${c.type}：表非空`, remedy: "接入端点重灌通道（删数据 → 再删类型）" },
        { type: "sql", sql: `DROP TABLE ${objectTable(c.type)} CASCADE`, description: `删表 ${c.type}` },
      ];
    case "add-property": {
      const prop = c.prop;
      const { type } = pgType(prop);
      const table = tableName(c.type);
      const ops: Op[] = [];
      if (prop.required && prop.default?.kind === "static") {
        // PG11+ 元数据-only：带默认值 + NOT NULL 一步到位
        ops.push({ type: "sql", sql: `ALTER TABLE ${objectTable(c.type)} ADD COLUMN ${quoteIdent(columnName(prop.apiName))} ${type}${prop.unique ? ` CONSTRAINT ${uniqueName(table, columnName(prop.apiName))} UNIQUE` : ""} NOT NULL DEFAULT ${literal(prop.default.value)}`, description: `${c.type}.${prop.apiName} NOT NULL DEFAULT` });
      } else {
        ops.push({ type: "sql", sql: `ALTER TABLE ${objectTable(c.type)} ADD COLUMN ${quoteIdent(columnName(prop.apiName))} ${type}`, description: `${c.type}.${prop.apiName} 可空列` });
        if (prop.unique) {
          ops.push({ type: "probe", sql: `SELECT 1`, description: "占位（新列无存量冲突）", violation: "" });
          ops.push({ type: "sql", sql: `ALTER TABLE ${objectTable(c.type)} ADD CONSTRAINT ${uniqueName(table, columnName(prop.apiName))} UNIQUE (${quoteIdent(columnName(prop.apiName))})`, description: `${c.type}.${prop.apiName} UNIQUE` });
        }
      }
      if (prop.type === "enum" && prop.values) {
        ops.push({ type: "sql", sql: `ALTER TABLE ${objectTable(c.type)} ADD CONSTRAINT ${checkName(table, columnName(prop.apiName))} CHECK (${quoteIdent(columnName(prop.apiName))} IS NULL OR ${quoteIdent(columnName(prop.apiName))} IN (${prop.values.map(sqlString).join(", ")}))`, description: `${c.type}.${prop.apiName} enum CHECK` });
      }
      const checks = scalarChecks(prop);
      if (checks.length > 0) {
        ops.push({ type: "sql", sql: `ALTER TABLE ${objectTable(c.type)} ADD CONSTRAINT ${checkName(table, columnName(prop.apiName))} CHECK (${quoteIdent(columnName(prop.apiName))} IS NULL OR (${checks.join(" AND ")}))`, description: `${c.type}.${prop.apiName} CHECK` });
      }
      if (prop.default?.kind === "static") {
        ops.push({ type: "sql", sql: `ALTER TABLE ${objectTable(c.type)} ALTER COLUMN ${quoteIdent(columnName(prop.apiName))} SET DEFAULT ${literal(prop.default.value)}`, description: `${c.type}.${prop.apiName} DEFAULT` });
      }
      return ops;
    }
    case "delete-property": {
      const col = columnName(c.prop.apiName);
      const table = tableName(c.type);
      const dropUnique = c.prop.unique ? `ALTER TABLE ${objectTable(c.type)} DROP CONSTRAINT IF EXISTS ${uniqueName(table, col)}; ` : "";
      return [
        { type: "probe", sql: `SELECT count(*)::int AS n FROM ${objectTable(c.type)} WHERE ${quoteIdent(col)} IS NOT NULL`, description: `${c.type}.${col} 空列探测`, violation: `删属性 ${c.type}.${c.prop.apiName}：存量存在非空值`, remedy: "一次性动作清值后再删（分多次 push）" },
        { type: "sql", sql: `ALTER TABLE ${objectTable(c.type)} DROP CONSTRAINT IF EXISTS ${checkName(table, col)}; ALTER TABLE ${objectTable(c.type)} DROP CONSTRAINT IF EXISTS ${uniqueName(table, col)}; ALTER TABLE ${objectTable(c.type)} DROP COLUMN ${quoteIdent(col)}`, description: `删列 ${c.type}.${col}` },
      ];
    }
    case "modify-property": {
      return buildModifyPropertyOps(c.type, c.from, c.to, cc);
    }
    case "add-link":
      return addLinkOps(c.link, c.type);
    case "delete-link":
      return deleteLinkOps(c.link, c.type);
    case "modify-link": {
      const ops: Op[] = [];
      const colFrom = linkPhysical(c.from, c.type);
      if (c.from.required && !c.to.required) {
        if (colFrom.mode === "fk") {
          ops.push({ type: "sql", sql: `ALTER TABLE ${objectTable(colFrom.fkTable)} ALTER COLUMN ${quoteIdent(colFrom.fkColumnSnake)} DROP NOT NULL`, description: `${colFrom.fkTable}.${colFrom.fkColumnSnake} 放宽` });
        }
      }
      if (!c.from.required && c.to.required) {
        if (colFrom.mode === "fk") {
          ops.push({ type: "probe", sql: `SELECT count(*)::int AS n FROM ${objectTable(colFrom.fkTable)} WHERE ${quoteIdent(colFrom.fkColumnSnake)} IS NULL`, description: "required 收紧探测", violation: `收紧 required：${c.type}.${c.to.apiName} 存在未链接对象`, remedy: REMEDY_DEFAULT });
          ops.push({ type: "sql", sql: `ALTER TABLE ${objectTable(colFrom.fkTable)} ALTER COLUMN ${quoteIdent(colFrom.fkColumnSnake)} SET NOT NULL`, description: `${colFrom.fkTable}.${colFrom.fkColumnSnake} NOT NULL` });
        }
      }
      return ops;
    }
    case "modify-struct": {
      // 引用方列全量形状校验（JS 侧逐行）→ 由 push 执行器走 rowValidate
      return [
        {
          type: "probe",
          sql: `SELECT count(*)::int AS n FROM ${JSON.stringify(structs)}::jsonb`, // 占位：真实校验在执行器（rowValidate）
          description: "struct 形状校验（执行器 rowValidate）",
          violation: "",
        },
      ];
    }
    default:
      // 纯注册面/元数据：无 DDL
      return [];
  }
}

function buildModifyPropertyOps(typeApi: string, from: PropertyDef, to: PropertyDef, cc: ClassifiedChange): Op[] {
  const ops: Op[] = [];
  const table = tableName(typeApi);
  const col = quoteIdent(columnName(to.apiName));
  const tbl = objectTable(typeApi);

  // required 收紧（带静态 default）
  if (!from.required && to.required && to.default?.kind === "static") {
    ops.push({ type: "sql", sql: `ALTER TABLE ${tbl} ALTER COLUMN ${col} SET DEFAULT ${literal(to.default.value)}`, description: `${typeApi}.${to.apiName} SET DEFAULT` });
    ops.push({ type: "probe", sql: `SELECT count(*)::int AS n FROM ${tbl} WHERE ${col} IS NULL`, description: "NOT NULL 前探测", violation: `收紧 required：${typeApi}.${to.apiName} 存量存在 NULL`, remedy: REMEDY_DEFAULT });
    ops.push({ type: "sql", sql: `ALTER TABLE ${tbl} ALTER COLUMN ${col} SET NOT NULL`, description: `${typeApi}.${to.apiName} NOT NULL` });
  }
  if (from.required && !to.required) {
    ops.push({ type: "sql", sql: `ALTER TABLE ${tbl} ALTER COLUMN ${col} DROP NOT NULL`, description: `${typeApi}.${to.apiName} 放宽` });
    if (from.default?.kind === "static") {
      ops.push({ type: "sql", sql: `ALTER TABLE ${tbl} ALTER COLUMN ${col} DROP DEFAULT`, description: `${typeApi}.${to.apiName} DROP DEFAULT` });
    }
  }

  // range/length/regex：替换 CHECK（收紧时新约束自动校验存量）
  const constraintIdentityChanged =
    JSON.stringify(from.range) !== JSON.stringify(to.range) ||
    JSON.stringify(from.length) !== JSON.stringify(to.length) ||
    JSON.stringify(from.regex) !== JSON.stringify(to.regex) ||
    JSON.stringify(from.values) !== JSON.stringify(to.values);
  if (constraintIdentityChanged) {
    const cname = checkName(table, columnName(to.apiName));
    ops.push({ type: "sql", sql: `ALTER TABLE ${tbl} DROP CONSTRAINT IF EXISTS ${cname}`, description: `替换 CHECK ${to.apiName}` });
    const checks = [...scalarChecks(to)];
    if (to.type === "enum" && to.values) {
      // enum 删值：探测存量引用，命中升格拒绝档（spec 60 §4.3）
      const removed = (from.values ?? []).filter((v) => !(to.values ?? []).includes(v));
      if (removed.length > 0) {
        ops.push({
          type: "probe",
          sql: `SELECT count(*)::int AS n FROM ${tbl} WHERE ${col} IN (${removed.map(sqlString).join(", ")})`,
          description: "enum 删值存量引用探测",
          violation: `enum 删值：${typeApi}.${to.apiName} 存量引用被删值 ${removed.map((v) => `"${v}"`).join(", ")}`,
          escalateBreaking: true,
          remedy: "先经一次性动作把存量行改为保留值，再删枚举值",
        });
      }
      ops.push({ type: "sql", sql: `ALTER TABLE ${tbl} ADD CONSTRAINT ${cname} CHECK (${col} IS NULL OR ${col} IN (${to.values.map(sqlString).join(", ")}))`, description: `${typeApi}.${to.apiName} enum CHECK` });
    }
    if (checks.length > 0) {
      ops.push({ type: "sql", sql: `ALTER TABLE ${tbl} ADD CONSTRAINT ${cname} CHECK (${col} IS NULL OR (${checks.join(" AND ")}))`, description: `${typeApi}.${to.apiName} CHECK` });
    }
  }

  // unique 增删
  if (!from.unique && to.unique) {
    ops.push({ type: "sql", sql: `ALTER TABLE ${tbl} ADD CONSTRAINT ${uniqueName(table, columnName(to.apiName))} UNIQUE (${col})`, description: `${typeApi}.${to.apiName} UNIQUE` });
  }
  if (from.unique && !to.unique) {
    ops.push({ type: "sql", sql: `ALTER TABLE ${tbl} DROP CONSTRAINT IF EXISTS ${uniqueName(table, columnName(to.apiName))}`, description: `${typeApi}.${to.apiName} 撤 UNIQUE` });
  }

  // 默认值增删（元数据）
  if (from.default?.kind === "static" && to.default?.kind === "static" && JSON.stringify(from.default) !== JSON.stringify(to.default)) {
    ops.push({ type: "sql", sql: `ALTER TABLE ${tbl} ALTER COLUMN ${col} SET DEFAULT ${literal(to.default.value)}`, description: `${typeApi}.${to.apiName} DEFAULT 更新` });
  }
  if (from.default && !to.default) {
    ops.push({ type: "sql", sql: `ALTER TABLE ${tbl} ALTER COLUMN ${col} DROP DEFAULT`, description: `${typeApi}.${to.apiName} DROP DEFAULT` });
  }
  if (!from.default && to.default?.kind === "static") {
    ops.push({ type: "sql", sql: `ALTER TABLE ${tbl} ALTER COLUMN ${col} SET DEFAULT ${literal(to.default.value)}`, description: `${typeApi}.${to.apiName} SET DEFAULT` });
  }

  return ops;
}

function literal(v: string | number | boolean | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return sqlString(v);
}

export { ONTOLOGY_SCHEMA };
