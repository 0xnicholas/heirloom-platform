/**
 * 安全面 —— 主体/组/PAT/读授权/动作白名单/安全日志（spec 50 章）。
 *
 * 引擎内置系统表承载（本体不定义主体——引导循环依赖）；授权 = 运行时数据，
 * 全部经本模块函数增删查（M6 管理面 1:1 包装）。
 *
 * 关键语义：
 * - PAT：`hlk_` 前缀不透明随机串，**只存 sha256**；明文仅签发时返回一次；
 *   吊销即时（revoked_at 判定）。
 * - 超管 isAdmin 短路一切检查（含行级过滤与白名单）——认证层最外层单点，
 *   非「授予所有权限」（spec 50 §3）；部署引导仅首个超管，幂等。
 * - 读授权 = 主体 ∪ 组 × 类型 ×（可选）谓词；多授权 **OR 并集**；无谓词 =
 *   全类型可见；**无任何授权 = 零行**——以恒假谓词（id IS NULL）表达，
 *   与空集在响应上不可区分（静默收窄，spec 50 §5/§7）。
 * - 谓词词汇 = 查询包算子 + ctx 常量（`{"$ctx": "userId" | "groups"}` 哨兵，
 *   装配时替换为实际值）；仅限本类型标量属性、无链接游走（spec 50 §6）。
 *   授权创建时 fail-closed 校验谓词可编译（悬空属性拒）。
 * - 动作白名单：主体或组 × 动作名，invoke 前置（引擎层拒 → 403
 *   WHITELIST_DENIED）；代码层 PermissionDenied 由 execute 抛出（403）
 *   ——两拒均落安全日志、不落审计（spec 50 §8/§10）。
 * - 安全日志只追加，与审计分立；查询永不落日志（防以日志探测授权面）。
 */
import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { OntologyDefinition } from "@heirloom/dsl";
import { compileFilterFragment, type FilterNode, type PredicateByType } from "./query.js";

// ────────────────────────────── 错误族 ──────────────────────────────

/** 无效/缺失/已吊销 token → HTTP 401 UNAUTHENTICATED + 安全日志（spec 30 §6） */
export class AuthenticationError extends Error {
  constructor(readonly reason: string) {
    super(`认证失败：${reason}`);
    this.name = "AuthenticationError";
  }
}

/** 引擎层白名单拒 → HTTP 403 WHITELIST_DENIED + 安全日志（spec 50 §8） */
export class WhitelistDeniedError extends Error {
  constructor(readonly subject: string, readonly actionApiName: string) {
    super(`主体 ${subject} 不在动作 ${actionApiName} 白名单`);
    this.name = "WhitelistDeniedError";
  }
}

/** 非超管调管理面 → HTTP 403 ADMIN_FORBIDDEN + 安全日志（spec 80 S11） */
export class AdminForbiddenError extends Error {
  constructor(readonly subject: string) {
    super(`主体 ${subject} 非超管，管理面拒绝`);
    this.name = "AdminForbiddenError";
  }
}

/** 授权数据非法（谓词不可编译/悬空属性）→ fail-closed 拒绝创建（spec 50 §9） */
export class GrantValidationError extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(`授权校验失败：${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "GrantValidationError";
  }
}

// ────────────────────────────── 认证上下文 ──────────────────────────────

export interface AuthContext {
  subjectId: string;
  subjectKind: "user" | "service";
  /** 主体名 = ctx.userId（spec 20 §3） */
  name: string;
  isAdmin: boolean;
  tokenId: string;
  /** 组名集合 = ctx.groups（直接成员、扁平，spec 50 §2） */
  groups: string[];
  /** 组 id 集合（授权装配用） */
  groupIds: string[];
}

type Db = Kysely<any>;

// ────────────────────────────── PAT ──────────────────────────────

/** 生成不透明 token：hlk_ + 32 字节随机（base64url）；只返回哈希入库 */
function mintToken(): { token: string; tokenHash: string } {
  const token = `hlk_${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: sha256(token) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 为主体签发 PAT（明文仅此一次返回，spec 30 §4.3） */
export async function issueToken(db: Db, subjectId: string): Promise<{ tokenId: string; token: string }> {
  const exists = await sql`SELECT 1 FROM hl_subjects WHERE id = ${subjectId}::uuid`.execute(db);
  if (exists.rows.length === 0) throw new Error(`主体不存在：${subjectId}`);
  const { token, tokenHash } = mintToken();
  const id = crypto.randomUUID();
  await sql`INSERT INTO hl_tokens (id, subject_id, token_hash) VALUES (${id}::uuid, ${subjectId}::uuid, ${tokenHash})`.execute(db);
  return { tokenId: id, token };
}

/** 引导专用：以指定明文落哈希（env HEIRLOOM_BOOTSTRAP_TOKEN；幂等——已存在同哈希则返回现有 id） */
export async function issueTokenWithValue(db: Db, subjectId: string, token: string): Promise<{ tokenId: string }> {
  if (!token.startsWith("hlk_")) throw new Error("引导 token 必须 hlk_ 前缀");
  const existing = await sql`SELECT id FROM hl_tokens WHERE token_hash = ${sha256(token)}`.execute(db);
  if (existing.rows.length > 0) return { tokenId: (existing.rows[0] as { id: string }).id };
  const id = crypto.randomUUID();
  await sql`INSERT INTO hl_tokens (id, subject_id, token_hash) VALUES (${id}::uuid, ${subjectId}::uuid, ${sha256(token)})`.execute(db);
  return { tokenId: id };
}

/** 吊销：即时生效（spec 30 §4.3） */
export async function revokeToken(db: Db, tokenId: string): Promise<boolean> {
  const r = await sql`UPDATE hl_tokens SET revoked_at = now() WHERE id = ${tokenId}::uuid AND revoked_at IS NULL`.execute(db);
  return Number(r.numAffectedRows ?? 0) > 0;
}

/** token 列表（无明文——哈希不出库，spec 30 §4.3） */
export async function listTokens(db: Db): Promise<{ id: string; subjectId: string; createdAt: string; revokedAt: string | null }[]> {
  const r = await sql`SELECT id, subject_id, created_at, revoked_at FROM hl_tokens ORDER BY created_at`.execute(db);
  return (r.rows as unknown as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    subjectId: row.subject_id as string,
    createdAt: row.created_at as string,
    revokedAt: (row.revoked_at as string | null) ?? null,
  }));
}

/** Bearer token → 认证上下文（无效/吊销 → AuthenticationError，安全日志由调用方记） */
export async function authenticate(db: Db, token: string): Promise<AuthContext> {
  if (typeof token !== "string" || !token.startsWith("hlk_")) {
    throw new AuthenticationError("token 格式非法（须 hlk_ 前缀）");
  }
  const r = await sql`
    SELECT t.id AS token_id, t.revoked_at,
           s.id AS subject_id, s.kind, s.name, s.is_admin,
           array_remove(array_agg(g.name), NULL) AS group_names,
           array_remove(array_agg(g.id), NULL) AS group_ids
    FROM hl_tokens t
    JOIN hl_subjects s ON s.id = t.subject_id
    LEFT JOIN hl_group_members m ON m.subject_id = s.id
    LEFT JOIN hl_groups g ON g.id = m.group_id
    WHERE t.token_hash = ${sha256(token)}
    GROUP BY t.id, s.id`.execute(db);
  const row = r.rows[0] as
    | { token_id: string; revoked_at: string | null; subject_id: string; kind: string; name: string; is_admin: boolean; group_names: string[]; group_ids: string[] }
    | undefined;
  if (!row) throw new AuthenticationError("无效 token");
  if (row.revoked_at) throw new AuthenticationError("token 已吊销");
  return {
    subjectId: row.subject_id,
    subjectKind: row.kind === "service" ? "service" : "user",
    name: row.name,
    isAdmin: row.is_admin,
    tokenId: row.token_id,
    groups: row.group_names ?? [],
    groupIds: row.group_ids ?? [],
  };
}

// ────────────────────────────── 超管引导 ──────────────────────────────

/** 引导首个超管（幂等：已有超管则 no-op，spec 50 §3）；S0 由部署环境变量驱动 */
export async function bootstrapAdmin(db: Db, name: string): Promise<{ subjectId: string | null; created: boolean }> {
  const existing = await sql`SELECT id FROM hl_subjects WHERE is_admin LIMIT 1`.execute(db);
  if (existing.rows.length > 0) {
    return { subjectId: (existing.rows[0] as { id: string }).id, created: false };
  }
  const id = crypto.randomUUID();
  await sql`INSERT INTO hl_subjects (id, kind, name, is_admin) VALUES (${id}::uuid, 'user', ${name}, true)`.execute(db);
  return { subjectId: id, created: true };
}

// ────────────────────────────── 主体/组管理 ──────────────────────────────

export interface SubjectHandle {
  subjectId: string;
}

export interface SubjectRow {
  subjectId: string;
  kind: "user" | "service";
  name: string;
  isAdmin: boolean;
  createdAt: string;
  groups: string[];
}

export async function listSubjects(db: Db): Promise<SubjectRow[]> {
  const r = await sql`
    SELECT s.id, s.kind, s.name, s.is_admin, s.created_at,
           array_remove(array_agg(g.name), NULL) AS groups
    FROM hl_subjects s
    LEFT JOIN hl_group_members m ON m.subject_id = s.id
    LEFT JOIN hl_groups g ON g.id = m.group_id
    GROUP BY s.id ORDER BY s.created_at, s.id`.execute(db);
  return (r.rows as unknown as Record<string, unknown>[]).map((row) => ({
    subjectId: row.id as string,
    kind: row.kind === "service" ? "service" : "user",
    name: row.name as string,
    isAdmin: Boolean(row.is_admin),
    createdAt: row.created_at as string,
    groups: (row.groups as string[]) ?? [],
  }));
}

export async function findSubjectByName(db: Db, name: string): Promise<SubjectRow | null> {
  return (await listSubjects(db)).find((s) => s.name === name) ?? null;
}

export async function updateSubject(db: Db, subjectId: string, patch: { name?: string; isAdmin?: boolean }): Promise<boolean> {
  const r = await sql`UPDATE hl_subjects SET
      name = COALESCE(${patch.name ?? null}, name),
      is_admin = COALESCE(${patch.isAdmin ?? null}, is_admin)
    WHERE id = ${subjectId}::uuid`.execute(db);
  return Number(r.numAffectedRows ?? 0) > 0;
}

export async function deleteSubject(db: Db, subjectId: string): Promise<boolean> {
  const r = await sql`DELETE FROM hl_subjects WHERE id = ${subjectId}::uuid`.execute(db);
  return Number(r.numAffectedRows ?? 0) > 0;
}

export async function createSubject(
  db: Db,
  opts: { kind: "user" | "service"; name: string; isAdmin?: boolean },
): Promise<SubjectHandle> {
  const id = crypto.randomUUID();
  await sql`INSERT INTO hl_subjects (id, kind, name, is_admin) VALUES (${id}::uuid, ${opts.kind}, ${opts.name}, ${opts.isAdmin ?? false})`.execute(db);
  return { subjectId: id };
}

export async function createGroup(db: Db, name: string): Promise<{ groupId: string }> {
  const id = crypto.randomUUID();
  await sql`INSERT INTO hl_groups (id, name) VALUES (${id}::uuid, ${name})`.execute(db);
  return { groupId: id };
}

export interface GroupRow {
  groupId: string;
  name: string;
  createdAt: string;
  memberCount: number;
}

export async function listGroups(db: Db): Promise<GroupRow[]> {
  const r = await sql`
    SELECT g.id, g.name, g.created_at, count(m.subject_id)::int AS member_count
    FROM hl_groups g LEFT JOIN hl_group_members m ON m.group_id = g.id
    GROUP BY g.id ORDER BY g.created_at, g.id`.execute(db);
  return (r.rows as unknown as Record<string, unknown>[]).map((row) => ({
    groupId: row.id as string,
    name: row.name as string,
    createdAt: row.created_at as string,
    memberCount: Number(row.member_count ?? 0),
  }));
}

export async function deleteGroup(db: Db, groupId: string): Promise<boolean> {
  const r = await sql`DELETE FROM hl_groups WHERE id = ${groupId}::uuid`.execute(db);
  return Number(r.numAffectedRows ?? 0) > 0;
}

export async function addGroupMember(db: Db, groupId: string, subjectId: string): Promise<void> {
  await sql`INSERT INTO hl_group_members (group_id, subject_id) VALUES (${groupId}::uuid, ${subjectId}::uuid) ON CONFLICT DO NOTHING`.execute(db);
}

export async function removeGroupMember(db: Db, groupId: string, subjectId: string): Promise<void> {
  await sql`DELETE FROM hl_group_members WHERE group_id = ${groupId}::uuid AND subject_id = ${subjectId}::uuid`.execute(db);
}

// ────────────────────────────── ctx 常量解析 ──────────────────────────────

/** 谓词内 ctx 哨兵：装配时替换为实际值（spec 50 §5；userId=主体名、groups=组名集） */
export function resolveCtxConstants(node: unknown, auth: { name: string; groups: readonly string[] }): unknown {
  if (Array.isArray(node)) return node.map((v) => resolveCtxConstants(v, auth));
  if (typeof node === "object" && node !== null) {
    const entries = Object.entries(node as Record<string, unknown>);
    if (entries.length === 1 && entries[0]![0] === "$ctx") {
      const key = entries[0]![1];
      if (key === "userId") return auth.name;
      if (key === "groups") return [...auth.groups];
      throw new GrantValidationError([{ path: "$ctx", message: `未知 ctx 常量：${String(key)}（仅 userId/groups）` }]);
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, resolveCtxConstants(v, auth)]));
  }
  return node;
}

// ────────────────────────────── 读授权 ──────────────────────────────

/** 谓词键不得含点路径（链接游走 → 反规范化建模纪律解决，spec 50 §6） */
function rejectLinkPaths(node: unknown, path = "predicate"): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => rejectLinkPaths(child, `${path}[${i}]`));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key !== "and" && key !== "or" && key !== "not" && key.includes(".")) {
      throw new GrantValidationError([{ path: `${path}.${key}`, message: "谓词仅限本类型属性，不得链接游走（spec 50 §6；跨类型切分用反规范化属性）" }]);
    }
    rejectLinkPaths(value, `${path}.${key}`);
  }
}

/** 恒假谓词：id IS NULL——零授权 = 零行 = 空集，与空过滤器同形（spec 50 §5/§7） */
export const DENY_ALL: FilterNode = { id: { eq: null } };

export interface ReadGrantInput {
  subjectId?: string;
  groupId?: string;
  typeApiName: string;
  /** 谓词 JSON（查询包算子 + $ctx 哨兵）；省缺 = 全类型可见 */
  predicate?: unknown;
}

/** 授予读授权：谓词先经 fail-closed 校验（可编译 + 仅本类型属性，spec 50 §6/§9） */
export async function grantRead(db: Db, def: OntologyDefinition, input: ReadGrantInput): Promise<{ grantId: string }> {
  if ((input.subjectId ? 1 : 0) + (input.groupId ? 1 : 0) !== 1) {
    throw new GrantValidationError([{ path: "subject/groupId", message: "subjectId 与 groupId 恰传其一" }]);
  }
  let predicate: unknown;
  if (input.predicate !== undefined && input.predicate !== null) {
    // 谓词仅限本类型属性、无链接游走（spec 50 §6）——点路径直接拒
    rejectLinkPaths(input.predicate);
    // 校验用哑 ctx（值类型兼容由编译器判定；哑值形状导致的误拒在文档注明）
    const resolved = resolveCtxConstants(input.predicate, { name: "user:probe", groups: [] });
    try {
      compileFilterFragment(input.typeApiName, def, resolved as FilterNode);
    } catch (e) {
      const issues =
        e instanceof Error && "issues" in e
          ? (e as { issues: { path: string; message: string }[] }).issues
          : [{ path: "predicate", message: (e as Error).message }];
      throw new GrantValidationError(issues);
    }
    predicate = JSON.parse(JSON.stringify(input.predicate));
  }
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO hl_read_grants (id, subject_id, group_id, type_api_name, predicate)
    VALUES (${id}::uuid, ${input.subjectId ?? null}::uuid, ${input.groupId ?? null}::uuid, ${input.typeApiName},
            ${predicate !== undefined ? JSON.stringify(predicate) : null}::jsonb)`.execute(db);
  return { grantId: id };
}

export async function revokeReadGrant(db: Db, grantId: string): Promise<boolean> {
  const r = await sql`DELETE FROM hl_read_grants WHERE id = ${grantId}::uuid`.execute(db);
  return Number(r.numAffectedRows ?? 0) > 0;
}

export interface ReadGrantRow {
  grantId: string;
  subjectId: string | null;
  groupId: string | null;
  typeApiName: string;
  predicate: unknown;
  createdAt: string;
}

export async function listReadGrants(db: Db): Promise<ReadGrantRow[]> {
  const r = await sql`SELECT id, subject_id, group_id, type_api_name, predicate, created_at FROM hl_read_grants ORDER BY created_at, id`.execute(db);
  return (r.rows as unknown as Record<string, unknown>[]).map((row) => ({
    grantId: row.id as string,
    subjectId: (row.subject_id as string) ?? null,
    groupId: (row.group_id as string) ?? null,
    typeApiName: row.type_api_name as string,
    predicate: row.predicate ?? null,
    createdAt: row.created_at as string,
  }));
}

/**
 * 装配主体的全类型读谓词表（喂 M3/M4 注入点 predicateByType）：
 * - 超管 → {}（全类型可见，最外层短路，spec 50 §3）；
 * - 主体授权 ∪ 各组授权按类型 OR 并集；任一无谓词 → 该类型全可见（无条目）；
 * - 零授权类型 → DENY_ALL（静默收窄）。
 */
export async function assembleReadPredicates(db: Db, auth: AuthContext, def: OntologyDefinition): Promise<PredicateByType> {
  if (auth.isAdmin) return {};
  const r = await sql`
    SELECT type_api_name, predicate
    FROM hl_read_grants
    WHERE subject_id = ${auth.subjectId}::uuid
       OR (cardinality(${auth.groupIds}::uuid[]) > 0 AND group_id = ANY(${auth.groupIds}::uuid[]))`.execute(db);
  const predicatesByType = new Map<string, FilterNode[]>();
  const fullTypes = new Set<string>();
  for (const row of r.rows as { type_api_name: string; predicate: unknown }[]) {
    if (row.predicate === null || row.predicate === undefined) fullTypes.add(row.type_api_name);
    else {
      const resolved = resolveCtxConstants(row.predicate, auth) as FilterNode;
      const list = predicatesByType.get(row.type_api_name) ?? [];
      list.push(resolved);
      predicatesByType.set(row.type_api_name, list);
    }
  }
  const out: PredicateByType = {};
  for (const t of def.objectTypes) {
    if (fullTypes.has(t.apiName)) continue; // 全可见 = 无条目
    const preds = predicatesByType.get(t.apiName);
    out[t.apiName] = !preds || preds.length === 0 ? DENY_ALL : preds.length === 1 ? preds[0]! : { or: preds };
  }
  return out;
}

// ────────────────────────────── 动作白名单 ──────────────────────────────

export interface ActionGrantInput {
  subjectId?: string;
  groupId?: string;
  actionApiName: string;
}

export async function grantAction(db: Db, input: ActionGrantInput): Promise<{ grantId: string }> {
  if ((input.subjectId ? 1 : 0) + (input.groupId ? 1 : 0) !== 1) {
    throw new GrantValidationError([{ path: "subject/groupId", message: "subjectId 与 groupId 恰传其一" }]);
  }
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO hl_action_grants (id, subject_id, group_id, action_api_name)
    VALUES (${id}::uuid, ${input.subjectId ?? null}::uuid, ${input.groupId ?? null}::uuid, ${input.actionApiName})`.execute(db);
  return { grantId: id };
}

export async function revokeActionGrant(db: Db, grantId: string): Promise<boolean> {
  const r = await sql`DELETE FROM hl_action_grants WHERE id = ${grantId}::uuid`.execute(db);
  return Number(r.numAffectedRows ?? 0) > 0;
}

export interface ActionGrantRow {
  grantId: string;
  subjectId: string | null;
  groupId: string | null;
  actionApiName: string;
  createdAt: string;
}

export async function listActionGrants(db: Db): Promise<ActionGrantRow[]> {
  const r = await sql`SELECT id, subject_id, group_id, action_api_name, created_at FROM hl_action_grants ORDER BY created_at, id`.execute(db);
  return (r.rows as unknown as Record<string, unknown>[]).map((row) => ({
    grantId: row.id as string,
    subjectId: (row.subject_id as string) ?? null,
    groupId: (row.group_id as string) ?? null,
    actionApiName: row.action_api_name as string,
    createdAt: row.created_at as string,
  }));
}

/** 引擎层白名单判定（invoke 前置；超管短路；拒 → WhitelistDeniedError，spec 50 §8） */
export async function checkActionAllowed(db: Db, auth: AuthContext, actionApiName: string): Promise<void> {
  if (auth.isAdmin) return;
  const groupIds = auth.groupIds;
  const r = (
    await sql`
      SELECT 1 FROM hl_action_grants
      WHERE action_api_name = ${actionApiName}
        AND (subject_id = ${auth.subjectId}::uuid
             OR (cardinality(${groupIds}::uuid[]) > 0 AND group_id = ANY(${groupIds}::uuid[])))
      LIMIT 1`.execute(db)
  );
  if (r.rows.length === 0) throw new WhitelistDeniedError(auth.name, actionApiName);
}

/** 管理面守卫：非超管 → AdminForbiddenError（spec 80 S11；日志由调用方记） */
export function assertAdmin(auth: AuthContext): void {
  if (!auth.isAdmin) throw new AdminForbiddenError(auth.name);
}

/** 接入端点授权（spec 70 §2 / 30 §4 唯一例外）：超管 或 持「ingest」接入授权的服务账号 */
export const INGEST_GRANT_ACTION = "ingest";

export async function checkIngestAllowed(db: Db, auth: AuthContext): Promise<void> {
  if (auth.isAdmin) return;
  if (auth.subjectKind === "service") {
    try {
      await checkActionAllowed(db, auth, INGEST_GRANT_ACTION);
      return;
    } catch {
      throw new AdminForbiddenError(auth.name);
    }
  }
  throw new AdminForbiddenError(auth.name);
}

// ────────────────────────────── 审计/安全日志查询（管理面只读，spec 30 §4 / 80 S11） ──────────────────────────────

export interface AuditRow {
  id: number;
  kind: string;
  subject: string | null;
  at: string;
  actionApiName: string | null;
  requestId: string | null;
  source: string | null;
  revisionFrom: number | null;
  revisionTo: number | null;
  params: unknown;
  edits: unknown;
  counts: unknown;
  changeCounts: unknown;
  durationMs: number | null;
}

export interface SecurityLogRow {
  id: number;
  at: string;
  code: string;
  subject: string | null;
  detail: unknown;
}

export interface ListFilters {
  limit?: number;
  cursor?: string;
  after?: string;
}

function decodeListCursor(cursor: string): number {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof v?.id !== "number") throw new Error();
    return v.id;
  } catch {
    throw new Error("游标不可解析");
  }
}

function encodeListCursor(id: number): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

/** 审计查询：kind/action/requestId/subject 过滤 + keyset（id 降序，新在前） */
export async function listAudit(
  db: Db,
  f: ListFilters & { kind?: string; action?: string; requestId?: string },
): Promise<{ rows: AuditRow[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  const conds: ReturnType<typeof sql>[] = [];
  if (f.kind) conds.push(sql`kind = ${f.kind}`);
  if (f.action) conds.push(sql`action_api_name = ${f.action}`);
  if (f.requestId) conds.push(sql`request_id = ${f.requestId}`);
  if (f.after) conds.push(sql`at > ${f.after}::timestamptz`);
  if (f.cursor) conds.push(sql`id < ${decodeListCursor(f.cursor)}`);
  const where = conds.length > 0 ? sql` WHERE ${sql.join(conds, sql` AND `)}` : sql``;
  const r = await sql`SELECT * FROM hl_audit_log${where} ORDER BY id DESC LIMIT ${limit + 1}`.execute(db);
  const rows = (r.rows as unknown as Record<string, unknown>[]).slice(0, limit).map((row) => ({
    id: Number(row.id),
    kind: row.kind as string,
    subject: (row.subject_id as string) ?? null,
    at: row.at as string,
    actionApiName: (row.action_api_name as string) ?? null,
    requestId: (row.request_id as string) ?? null,
    source: (row.source as string) ?? null,
    revisionFrom: row.revision_from === null ? null : Number(row.revision_from),
    revisionTo: row.revision_to === null ? null : Number(row.revision_to),
    params: row.params ?? null,
    edits: row.edits ?? null,
    counts: row.counts ?? null,
    changeCounts: row.change_counts ?? null,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
  }));
  const hasMore = (r.rows as unknown[]).length > limit;
  return hasMore && rows.length > 0 ? { rows, nextCursor: encodeListCursor(rows[rows.length - 1]!.id) } : { rows };
}

/** 安全日志查询：code/subject 过滤 + keyset */
export async function listSecurityLog(
  db: Db,
  f: ListFilters & { code?: string; subject?: string },
): Promise<{ rows: SecurityLogRow[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  const conds: ReturnType<typeof sql>[] = [];
  if (f.code) conds.push(sql`code = ${f.code}`);
  if (f.subject) conds.push(sql`subject = ${f.subject}`);
  if (f.after) conds.push(sql`at > ${f.after}::timestamptz`);
  if (f.cursor) conds.push(sql`id < ${decodeListCursor(f.cursor)}`);
  const where = conds.length > 0 ? sql` WHERE ${sql.join(conds, sql` AND `)}` : sql``;
  const r = await sql`SELECT * FROM hl_security_log${where} ORDER BY id DESC LIMIT ${limit + 1}`.execute(db);
  const rows = (r.rows as unknown as Record<string, unknown>[]).slice(0, limit).map((row) => ({
    id: Number(row.id),
    at: row.at as string,
    code: row.code as string,
    subject: (row.subject as string) ?? null,
    detail: row.detail ?? null,
  }));
  const hasMore = (r.rows as unknown[]).length > limit;
  return hasMore && rows.length > 0 ? { rows, nextCursor: encodeListCursor(rows[rows.length - 1]!.id) } : { rows };
}

// ────────────────────────────── 安全日志 ──────────────────────────────

export interface SecurityEvent {
  /** 错误码注册表（spec 90）：UNAUTHENTICATED / WHITELIST_DENIED / PERMISSION_DENIED / ADMIN_FORBIDDEN */
  code: string;
  /** 主体名（可知时） */
  subject?: string | null;
  actionApiName?: string | null;
  reason?: string | null;
}

/** 只追加安全日志（与审计分立；查询永不落日志，spec 50 §10） */
export async function logSecurityEvent(db: Db, event: SecurityEvent): Promise<void> {
  await sql`
    INSERT INTO hl_security_log (code, subject, detail)
    VALUES (${event.code}, ${event.subject ?? null}, ${JSON.stringify({
      action: event.actionApiName ?? null,
      reason: event.reason ?? null,
    })}::jsonb)`.execute(db);
}
