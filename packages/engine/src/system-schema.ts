/**
 * 引擎系统表 —— 迁移平面与本体 DDL 平面分立（spec 60 §1 / 70 §7）。
 *
 * 只向前；advisory lock 防并发；`migrateOnly` 供迁移/运行账号分离部署。
 * 系统表一律 hl_ 前缀置于 public（本体表在独立 schema，零保留名冲突）。
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

export interface EngineDatabase {
  // 本体面由动态 DDL 管理，类型层不在此声明
}

export function createDb(databaseUrl: string): Kysely<EngineDatabase> {
  return new Kysely<EngineDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: databaseUrl, max: 10 }),
    }),
  });
}

interface Migration {
  version: number;
  name: string;
  up: string[];
}

/** V1：全部引擎系统表一次到位（M2–M6 共用，避免中途加迁移） */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "system-core",
    up: [
      `CREATE TABLE IF NOT EXISTS hl_schema_migrations (
         version bigint PRIMARY KEY,
         name text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
      // 本体权威态：当前生效定义 + 单调 revision（spec 60 §2.2）
      `CREATE TABLE IF NOT EXISTS hl_ontology (
         id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
         revision bigint NOT NULL DEFAULT 0,
         definition jsonb NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
      `INSERT INTO hl_ontology (id, revision, definition)
         VALUES (1, 0, '{"structs":[],"objectTypes":[],"actions":[],"functions":[],"bindings":{}}'::jsonb)
         ON CONFLICT DO NOTHING`,
      // 主体：用户与服务账号同构（spec 50 §2）
      `CREATE TABLE IF NOT EXISTS hl_subjects (
         id uuid PRIMARY KEY,
         kind text NOT NULL CHECK (kind IN ('user', 'service')),
         name text NOT NULL,
         is_admin boolean NOT NULL DEFAULT false,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
      // 组：扁平不嵌套（spec 50 §2）
      `CREATE TABLE IF NOT EXISTS hl_groups (
         id uuid PRIMARY KEY,
         name text NOT NULL UNIQUE,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS hl_group_members (
         group_id uuid NOT NULL REFERENCES hl_groups (id) ON DELETE CASCADE,
         subject_id uuid NOT NULL REFERENCES hl_subjects (id) ON DELETE CASCADE,
         PRIMARY KEY (group_id, subject_id)
       )`,
      // PAT：只存哈希；吊销即时（spec 50 §4）
      `CREATE TABLE IF NOT EXISTS hl_tokens (
         id uuid PRIMARY KEY,
         subject_id uuid NOT NULL REFERENCES hl_subjects (id) ON DELETE CASCADE,
         token_hash text NOT NULL UNIQUE,
         created_at timestamptz NOT NULL DEFAULT now(),
         revoked_at timestamptz
       )`,
      // 读授权：类型级 + 行级谓词（spec 50 §5）
      `CREATE TABLE IF NOT EXISTS hl_read_grants (
         id uuid PRIMARY KEY,
         subject_id uuid REFERENCES hl_subjects (id) ON DELETE CASCADE,
         group_id uuid REFERENCES hl_groups (id) ON DELETE CASCADE,
         type_api_name text NOT NULL,
         predicate jsonb,
         created_at timestamptz NOT NULL DEFAULT now(),
         CHECK (subject_id IS NOT NULL OR group_id IS NOT NULL),
         CHECK (NOT (subject_id IS NOT NULL AND group_id IS NOT NULL))
       )`,
      // 动作白名单（spec 50 §8）
      `CREATE TABLE IF NOT EXISTS hl_action_grants (
         id uuid PRIMARY KEY,
         subject_id uuid REFERENCES hl_subjects (id) ON DELETE CASCADE,
         group_id uuid REFERENCES hl_groups (id) ON DELETE CASCADE,
         action_api_name text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         CHECK (subject_id IS NOT NULL OR group_id IS NOT NULL),
         CHECK (NOT (subject_id IS NOT NULL AND group_id IS NOT NULL))
       )`,
      // 审计：动作条目 + 导入批次 + push 条目同一家族（spec 20 §10 / 70 §4 / 60 §3）
      `CREATE TABLE IF NOT EXISTS hl_audit_log (
         id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         kind text NOT NULL CHECK (kind IN ('action', 'import-batch', 'push')),
         subject_id uuid,
         subject_kind text,
         token_id uuid,
         at timestamptz NOT NULL DEFAULT now(),
         action_api_name text,
         params jsonb,
         edits jsonb,
         expected_updated_at_used boolean,
         transaction_id text,
         duration_ms bigint,
         revision_from bigint,
         revision_to bigint,
         change_counts jsonb,
         request_id text,
         counts jsonb,
         source text
       )`,
      `CREATE INDEX IF NOT EXISTS hl_audit_kind_at_idx ON hl_audit_log (kind, at)`,
      // 安全日志：认证失败与授权拒绝，与审计分立（spec 50 §10）
      `CREATE TABLE IF NOT EXISTS hl_security_log (
         id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         at timestamptz NOT NULL DEFAULT now(),
         code text NOT NULL,
         subject text,
         detail jsonb
       )`,
      `CREATE INDEX IF NOT EXISTS hl_security_code_at_idx ON hl_security_log (code, at)`,
      // 本体 schema 容器
      `CREATE SCHEMA IF NOT EXISTS ontology`,
      `CREATE SCHEMA IF NOT EXISTS ontology_links`,
    ],
  },
];

const ADVISORY_LOCK_KEY = 8_450_213; // 'heirloom-migrate' 任意固定键

/** 迁移入口：幂等、advisory lock 防并发（spec 70 §7） */
export async function runMigrations(db: Kysely<any>): Promise<{ applied: number }> {
  await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`.execute(db);
  try {
    let applied = 0;
    const hasMigrationsTable =
      (
        await sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'hl_schema_migrations'`.execute(db)
      ).rows.length > 0;
    for (const m of MIGRATIONS) {
      if (hasMigrationsTable) {
        const exists = await sql`SELECT 1 FROM hl_schema_migrations WHERE version = ${m.version}`.execute(db);
        if (exists.rows.length > 0) continue;
      }
      await sql`BEGIN`.execute(db);
      try {
        for (const stmt of m.up) await sql.raw(stmt).execute(db);
        await sql`INSERT INTO hl_schema_migrations (version, name) VALUES (${m.version}, ${m.name})`.execute(db);
        await sql`COMMIT`.execute(db);
        applied++;
      } catch (e) {
        await sql`ROLLBACK`.execute(db).catch(() => {});
        throw e;
      }
    }
    return { applied };
  } finally {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`.execute(db);
  }
}

/** 迁移/运行账号分离部署的逃生门（spec 70 §7）：只跑迁移即退出 */
export async function migrateOnly(databaseUrl: string): Promise<{ applied: number }> {
  const db = createDb(databaseUrl);
  try {
    return await runMigrations(db);
  } finally {
    await db.destroy();
  }
}
