/**
 * 启动入口 —— compose/裸机共用（spec 70 §6/§7）：
 * 引擎 schema 迁移自动执行（advisory lock 防并发）→ 超管引导（env）→ 监听。
 * 配置面仅环境变量（12-factor，spec 70 §8）：DATABASE_URL / PORT /
 * HEIRLOOM_BOOTSTRAP_ADMIN / HEIRLOOM_BOOTSTRAP_TOKEN / HEIRLOOM_ACTION_TIMEOUT_MS。
 */
import { bootstrapAdmin, createDb, issueTokenWithValue, runMigrations } from "@heirloom/engine";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("缺少 DATABASE_URL（spec 70 §6：唯一部署抽象）");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 3000);

  // 1. 迁移（自动 + advisory lock，spec 70 §7）；分离部署可 HEIRLOOM_SKIP_MIGRATE=1
  // （迁移账号先跑 migrate-only，运行账号免 DDL 权限）
  const db = createDb(databaseUrl);
  try {
    if (process.env.HEIRLOOM_SKIP_MIGRATE !== "1") {
      const { applied } = await runMigrations(db);
      if (applied > 0) console.log(`[heirloom] 引擎迁移：${applied} 条已应用`);
    }

    // 2. 超管引导（幂等；spec 50 §3）+ 引导 token（HEIRLOOM_BOOTSTRAP_TOKEN，实现自由度）
    const adminName = process.env.HEIRLOOM_BOOTSTRAP_ADMIN;
    if (adminName) {
      const { subjectId, created } = await bootstrapAdmin(db, adminName);
      const bootstrapToken = process.env.HEIRLOOM_BOOTSTRAP_TOKEN;
      if (created && subjectId && bootstrapToken) {
        await issueTokenWithValue(db, subjectId, bootstrapToken);
        console.log(`[heirloom] 已引导超管 ${adminName}（HEIRLOOM_BOOTSTRAP_TOKEN 生效）`);
      } else if (created) {
        console.log(`[heirloom] 已引导超管 ${adminName}（用管理面签发 PAT）`);
      }
    }
  } finally {
    await db.destroy();
  }

  // 3. HTTP 面
  const app = await buildApp({
    databaseUrl,
    actionTimeoutMs: process.env.HEIRLOOM_ACTION_TIMEOUT_MS !== undefined ? Number(process.env.HEIRLOOM_ACTION_TIMEOUT_MS) : undefined,
  });
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`[heirloom] listening on :${port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
