/**
 * 命名映射 —— apiName ↔ 物理标识符（spec 40 §2 一类型一表）。
 *
 * 对象表进独立 schema `ontology`（与系统表 public/hl_* 平面分立，免保留名规则）；
 * M:N 链接表进 `ontology_links`。
 * apiName kebab→snake、属性 camel→snake；PG 标识符一律双引号包裹。
 */

export const ONTOLOGY_SCHEMA = "ontology";
export const LINKS_SCHEMA = "ontology_links";

/** kebab-case apiName → snake_case 表名 */
export function tableName(apiName: string): string {
  return apiName.replace(/-/g, "_");
}

/** camelCase apiName → snake_case 列名 */
export function columnName(apiName: string): string {
  return apiName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 对象表全限定名 */
export function objectTable(apiName: string): string {
  return `${quoteIdent(ONTOLOGY_SCHEMA)}.${quoteIdent(tableName(apiName))}`;
}

/** M:N 链接表全限定名：声明方 + 链接名（同声明方内链接名唯一 → 表名唯一） */
export function linkTable(declarer: string, linkName: string): string {
  return `${quoteIdent(LINKS_SCHEMA)}.${quoteIdent(`${tableName(declarer)}_${columnName(linkName)}`)}`;
}

export function checkName(table: string, col: string, suffix = ""): string {
  return quoteIdent(`chk_${table}_${col}${suffix}`);
}

export function uniqueName(table: string, col: string): string {
  return quoteIdent(`uq_${table}_${col}`);
}

export function fkName(table: string, col: string): string {
  return quoteIdent(`fk_${table}_${col}`);
}

/** SQL 字符串字面量转义（DDL 内 CHECK 值集等不能用绑定参数的场景） */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
