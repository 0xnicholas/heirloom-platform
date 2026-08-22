#!/usr/bin/env node
/**
 * heirloom CLI —— 端点薄壳 + 迁移入口（spec 30 §7）：
 *   heirloom ontology apply <path>     → PUT /v1/admin/ontology
 *   heirloom import <csv> --type T [--source S] → POST /v1/admin/ingest（分批）
 *   heirloom migrate-only              → 引擎迁移入口（非 HTTP，spec 70 §7）
 *   heirloom admin <…>                 → /v1/admin/* CRUD 1:1
 * 配置：--url/HEIRLOOM_URL（缺省 http://127.0.0.1:3000）、--token/HEIRLOOM_TOKEN。
 */
import { migrateOnly } from "@heirloom/engine";
import { clientFromEnv } from "./client.js";
import { runApply } from "./apply.js";
import { runImport } from "./import.js";
import { runAdmin } from "./admin.js";

function help(): void {
  console.log(`heirloom — Heirloom 平台 CLI（端点 1:1 薄壳）

用法：
  heirloom ontology apply <ontology.ts | 目录>   推送本体（esbuild 求值 → PUT）
  heirloom import <data.csv> --type T [--source S]  CSV 批量接入（≤1000/批自动分批）
  heirloom migrate-only                          引擎 schema 迁移（DATABASE_URL）
  heirloom admin subjects|groups|read-grants|action-grants|tokens …
                                                 管理面 CRUD（详见各子命令报错提示）

环境：
  HEIRLOOM_URL    服务地址（缺省 http://127.0.0.1:3000）
  HEIRLOOM_TOKEN  PAT（Bearer）
  DATABASE_URL    migrate-only 用`);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const globalFlags = argv.filter((a) => a.startsWith("--"));
  const cleanRest = rest.filter((a) => !a.startsWith("--"));
  const gflag = (name: string): string | undefined => {
    const hit = globalFlags.find((f) => f === `--${name}` || f.startsWith(`--${name}=`));
    if (hit === undefined) return undefined;
    return hit.includes("=") ? hit.split("=")[1] : "true";
  };

  if (cmd === "ontology" && cleanRest[0] === "apply") {
    const path = cleanRest[1];
    if (!path) throw new Error("用法：heirloom ontology apply <ontology.ts>");
    await runApply(clientFromEnv({ url: gflag("url"), token: gflag("token") }), path);
  } else if (cmd === "import") {
    const csvPath = cleanRest[0];
    const type = gflag("type");
    if (!csvPath || !type) throw new Error("用法：heirloom import <data.csv> --type T [--source S]");
    await runImport(clientFromEnv({ url: gflag("url"), token: gflag("token") }), { csvPath, type, source: gflag("source") });
  } else if (cmd === "migrate-only") {
    if (!process.env.DATABASE_URL) throw new Error("缺少 DATABASE_URL（spec 70 §7）");
    const { applied } = await migrateOnly(process.env.DATABASE_URL);
    console.log(applied > 0 ? `已应用 ${applied} 条迁移` : "无可应用迁移（最新）");
  } else if (cmd === "admin") {
    await runAdmin(clientFromEnv({ url: gflag("url"), token: gflag("token") }), cleanRest);
  } else {
    help();
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
