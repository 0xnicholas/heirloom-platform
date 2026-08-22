/**
 * `heirloom import <csv> --type T --source S` —— CSV → 批量 JSON → 接入端点
 * （spec 70 §3：列映射/编码/错误报告全在客户端；>1000 行自动分批 ≤1000/批）。
 * 值编码按本体定义逐列转换（integer/float→number、decimal→字符串、
 * boolean→bool、json/struct→JSON.parse、其余字符串；空串 = 缺省）。
 */
import { readFileSync } from "node:fs";
import { api, type ClientOptions } from "./client.js";
import { parseCsv } from "./csv.js";

interface MetaResponse {
  revision: number;
  definition: { objectTypes: { apiName: string; properties: { apiName: string; type: string; array?: unknown }[] }[] };
}

function coerce(valueType: string, raw: string, at: string): unknown {
  switch (valueType) {
    case "integer":
    case "float": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${at}：无法转为数值（${raw}）`);
      return n;
    }
    case "boolean": {
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(`${at}：无法转为布尔（${raw}；仅 true/false）`);
    }
    case "decimal":
      return raw; // 全链路字符串（spec 10 §3）
    case "json":
    case "struct":
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`${at}：无法解析 JSON（${raw}）`);
      }
    default:
      return raw; // string/enum/date/datetime
  }
}

export async function runImport(
  opts: ClientOptions,
  args: { csvPath: string; type: string; source?: string },
): Promise<void> {
  const meta = await api<MetaResponse>(opts, "GET", "/v1/meta/ontology");
  const typeDef = meta.definition.objectTypes.find((t) => t.apiName === args.type);
  if (!typeDef) {
    throw new Error(`对象类型不存在：${args.type}（先 heirloom ontology apply）`);
  }
  const propType = new Map(typeDef.properties.map((p) => [p.apiName, p.type]));

  const rows = parseCsv(readFileSync(args.csvPath, "utf8"));
  if (rows.length < 2) {
    console.log("CSV 无数据行（仅表头或空文件）");
    return;
  }
  const header = rows[0]!;
  for (const h of header) {
    if (!propType.has(h)) throw new Error(`列 "${h}" 不在 ${args.type} 属性集中（客户端列映射失败）`);
  }

  const operations = rows.slice(1).map((values, r) => {
    const object: Record<string, unknown> = {};
    header.forEach((key, i) => {
      const raw = values[i] ?? "";
      if (raw === "") return; // 空串 = 缺省
      object[key] = coerce(propType.get(key)!, raw, `第 ${r + 2} 行 ${key} 列`);
    });
    return { type: args.type, op: "create" as const, object };
  });

  const BATCH = 1000;
  const batches = Math.ceil(operations.length / BATCH) || 1;
  let done = 0;
  for (let b = 0; b < batches; b++) {
    const slice = operations.slice(b * BATCH, (b + 1) * BATCH);
    const result = await api<{ requestId: string; counts: Record<string, Record<string, number>> }>(
      opts,
      "POST",
      "/v1/admin/ingest",
      { ...(args.source !== undefined ? { source: args.source } : {}), operations: slice },
    );
    done += slice.length;
    console.log(`批次 ${b + 1}/${batches} → ${result.requestId}（${JSON.stringify(result.counts)}；累计 ${done}/${operations.length}）`);
  }
}
