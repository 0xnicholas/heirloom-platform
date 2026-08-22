/**
 * Heirloom REST server —— 语义面五件套 + 管理面 /v1/admin/*（spec 30）。
 *
 * 端点集对任意本体不变（spec 30 §1）；本体定义从 hl_ontology 加载
 * （push 后失效重载）。认证 = 全端点 Bearer PAT（spec 30 §2 / 50 §4）；
 * 零授权查询 = 200 空集（静默收窄，永不 403）。
 */
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { sql, type Kysely } from "kysely";
import type { OntologyDefinition } from "@heirloom/dsl";
import {
  addGroupMember,
  assembleReadPredicates,
  assertAdmin,
  authenticate,
  AuthenticationError,
  checkActionAllowed,
  checkIngestAllowed,
  createDb,
  createGroup,
  createSubject,
  deleteGroup,
  deleteSubject,
  executeQuery,
  findSubjectByName,
  grantAction,
  grantRead,
  ingestBatch,
  invokeAction,
  invokeFunction,
  issueToken,
  listActionGrants,
  listAudit,
  listGroups,
  listReadGrants,
  listSecurityLog,
  listSubjects,
  listTokens,
  logSecurityEvent,
  PermissionDenied,
  pgExec,
  pushOntology,
  removeGroupMember,
  revokeActionGrant,
  revokeReadGrant,
  revokeToken,
  updateSubject,
  WhitelistDeniedError,
  type AuthContext,
} from "@heirloom/engine";
import { errorHandler, sendError } from "./http-error.js";

export interface ServerOptions {
  databaseUrl: string;
  /** 动作事务超时上限（spec 20 §6；env HEIRLOOM_ACTION_TIMEOUT_MS） */
  actionTimeoutMs?: number;
}

interface DefinitionState {
  revision: number;
  definition: OntologyDefinition;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

export async function buildApp(opts: ServerOptions): Promise<FastifyInstance> {
  const pool = new Pool({ connectionString: opts.databaseUrl });
  const db: Kysely<any> = createDb(opts.databaseUrl);
  const actionTimeoutMs = opts.actionTimeoutMs ?? 30_000;
  const exec = pgExec(pool);

  // 本体定义缓存（push 后失效）
  let defState: DefinitionState | null = null;
  const loadDefinition = async (): Promise<DefinitionState> => {
    if (defState) return defState;
    const r = await sql`SELECT revision, definition FROM hl_ontology WHERE id = 1`.execute(db);
    const row = r.rows[0] as { revision: number | string; definition: OntologyDefinition } | undefined;
    defState = { revision: Number(row?.revision ?? 0), definition: (row?.definition ?? { structs: [], objectTypes: [], actions: [], functions: [], bindings: {} }) as OntologyDefinition };
    return defState;
  };
  const invalidateDefinition = (): void => {
    defState = null;
  };

  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);

  // ── 认证钩子：全端点 Bearer PAT（spec 30 §2）──
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      await logSecurityEvent(db, { code: "UNAUTHENTICATED", reason: "缺失 token" });
      sendError(reply, 401, "UNAUTHENTICATED", "认证失败：缺失 Bearer token");
      return reply;
    }
    try {
      request.auth = await authenticate(db, header.slice("Bearer ".length));
    } catch (e) {
      const reason = e instanceof AuthenticationError ? e.reason : "无效 token";
      await logSecurityEvent(db, { code: "UNAUTHENTICATED", reason });
      sendError(reply, 401, "UNAUTHENTICATED", `认证失败：${reason}`);
      return reply;
    }
  });

  /** 管理面守卫：拒 → 403 ADMIN_FORBIDDEN + 安全日志（spec 80 S11） */
  const requireAdmin = async (request: { auth: AuthContext }): Promise<void> => {
    try {
      assertAdmin(request.auth); // 原始守卫（勿改回 requireAdmin——会自递归）
    } catch (e) {
      await logSecurityEvent(db, { code: "ADMIN_FORBIDDEN", subject: request.auth.name, reason: "非超管调管理面" });
      throw e;
    }
  };

  const actorOf = (auth: AuthContext) => ({
    subjectId: auth.subjectId,
    subjectKind: auth.subjectKind,
    tokenId: auth.tokenId,
    userId: auth.name,
    groups: auth.groups,
  });

  // ══════════ 语义面五件套（spec 30 §3）══════════

  // 3.1 对象查询
  app.post("/v1/objects/:type/query", async (request, reply) => {
    const { type } = request.params as { type: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const state = await loadDefinition();
    const predicateByType = await assembleReadPredicates(db, request.auth, state.definition);
    const result = await executeQuery(exec, type, state.definition, {
      filter: body.filter as never,
      sort: body.sort as never,
      cursor: body.cursor as string | undefined,
      limit: body.limit as number | undefined,
      include: body.include as string[] | undefined,
      count: body.count as boolean | undefined,
    }, { predicateByType });
    return reply.send(result); // {data, nextCursor?, count?}
  });

  // 3.2 单对象取（?include=…；If-Match 乐观锁）
  app.get("/v1/objects/:type/:id", async (request, reply) => {
    const { type, id } = request.params as { type: string; id: string };
    const include = (request.query as { include?: string | string[] }).include;
    const ifMatch = request.headers["if-match"];
    const state = await loadDefinition();
    const predicateByType = await assembleReadPredicates(db, request.auth, state.definition);
    const result = await executeQuery(exec, type, state.definition, {
      filter: { id: { eq: id } },
      include: include === undefined ? undefined : Array.isArray(include) ? include : [include],
    }, { predicateByType });
    if (result.data.length === 0) {
      return sendError(reply, 404, "NOT_FOUND", `对象不存在或不可见：${type} ${id}`); // 零行/拒绝不可区分（spec 30 §3.2）
    }
    const row = result.data[0]!;
    if (ifMatch !== undefined && row.updatedAt !== ifMatch) {
      return sendError(reply, 409, "PRECONDITION_FAILED", "If-Match 命中旧值（updated_at 已变）");
    }
    return reply.send({ data: row });
  });

  // 3.3 动作调用（白名单前置 → 单事务 execute）
  app.post("/v1/actions/:apiName/invoke", async (request, reply) => {
    const { apiName } = request.params as { apiName: string };
    const state = await loadDefinition();
    if (!state.definition.actions.some((a) => a.apiName === apiName)) {
      return sendError(reply, 404, "NOT_FOUND", `动作不存在：${apiName}`);
    }
    try {
      await checkActionAllowed(db, request.auth, apiName);
    } catch (e) {
      if (e instanceof WhitelistDeniedError) {
        await logSecurityEvent(db, { code: "WHITELIST_DENIED", subject: request.auth.name, actionApiName: apiName, reason: "白名单外主体" });
      }
      throw e;
    }
    try {
      const result = await invokeAction(pool, state.definition, apiName, (request.body ?? {}) as Record<string, unknown>, actorOf(request.auth), { timeoutMs: actionTimeoutMs });
      return reply.send({ data: result.result });
    } catch (e) {
      if (e instanceof PermissionDenied) {
        await logSecurityEvent(db, { code: "PERMISSION_DENIED", subject: request.auth.name, actionApiName: apiName, reason: e.message });
      }
      throw e;
    }
  });

  // 3.4 只读函数调用（读授权谓词照常注入）
  app.post("/v1/functions/:apiName/invoke", async (request, reply) => {
    const { apiName } = request.params as { apiName: string };
    const state = await loadDefinition();
    if (!state.definition.functions.some((f) => f.apiName === apiName)) {
      return sendError(reply, 404, "NOT_FOUND", `函数不存在：${apiName}`);
    }
    const predicateByType = await assembleReadPredicates(db, request.auth, state.definition);
    const result = await invokeFunction(pool, state.definition, apiName, (request.body ?? {}) as Record<string, unknown>, actorOf(request.auth), { timeoutMs: actionTimeoutMs, predicateByType });
    return reply.send({ data: result });
  });

  // 3.5 introspection
  app.get("/v1/meta/ontology", async (_request, reply) => {
    invalidateDefinition();
    const state = await loadDefinition();
    return reply.send({ revision: state.revision, definition: state.definition });
  });

  // ══════════ 管理面 /v1/admin/*（spec 30 §4）══════════

  // 4.1 push
  app.put("/v1/admin/ontology", async (request, reply) => {
    await requireAdmin(request);
    const definition = request.body as OntologyDefinition;
    const result = await pushOntology(db, definition, {
      subjectId: request.auth.subjectId,
      subjectKind: request.auth.subjectKind,
      tokenId: request.auth.tokenId,
    });
    invalidateDefinition();
    return reply.send(result);
  });

  // 4.2 ingest（唯一非超管例外：持接入授权的服务账号）
  app.post("/v1/admin/ingest", async (request, reply) => {
    try {
      await checkIngestAllowed(db, request.auth);
    } catch (e) {
      await logSecurityEvent(db, { code: "ADMIN_FORBIDDEN", subject: request.auth.name, reason: "接入授权缺失" });
      throw e;
    }
    const body = (request.body ?? {}) as { source?: string; operations?: unknown[] };
    const state = await loadDefinition();
    const result = await ingestBatch(pool, state.definition, body.source ?? null, body.operations ?? [], actorOf(request.auth));
    return reply.send(result);
  });

  // 4.3 审计 / 安全日志（keyset 过滤只读）
  app.get("/v1/admin/audit", async (request, reply) => {
    await requireAdmin(request);
    const q = request.query as Record<string, string | undefined>;
    const result = await listAudit(db, {
      kind: q.kind,
      action: q.action,
      requestId: q.requestId,
      after: q.after,
      cursor: q.cursor,
      limit: q.limit !== undefined ? Number(q.limit) : undefined,
    });
    return reply.send({ data: result.rows, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) });
  });

  app.get("/v1/admin/security-log", async (request, reply) => {
    await requireAdmin(request);
    const q = request.query as Record<string, string | undefined>;
    const result = await listSecurityLog(db, {
      code: q.code,
      subject: q.subject,
      after: q.after,
      cursor: q.cursor,
      limit: q.limit !== undefined ? Number(q.limit) : undefined,
    });
    return reply.send({ data: result.rows, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) });
  });

  // subjects CRUD
  app.post("/v1/admin/subjects", async (request, reply) => {
    await requireAdmin(request);
    const body = request.body as { kind?: string; name?: string; isAdmin?: boolean };
    if ((body.kind !== "user" && body.kind !== "service") || typeof body.name !== "string") {
      return sendError(reply, 400, "BAD_REQUEST", "body 须含 kind(user|service) 与 name");
    }
    const r = await createSubject(db, { kind: body.kind, name: body.name, isAdmin: body.isAdmin });
    return reply.send(r);
  });
  app.get("/v1/admin/subjects", async (request, reply) => {
    await requireAdmin(request);
    return reply.send({ data: await listSubjects(db) });
  });
  app.patch("/v1/admin/subjects/:id", async (request, reply) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; isAdmin?: boolean };
    const ok = await updateSubject(db, id, body);
    return ok ? reply.send({ updated: true }) : sendError(reply, 404, "NOT_FOUND", `主体不存在：${id}`);
  });
  app.delete("/v1/admin/subjects/:id", async (request, reply) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const ok = await deleteSubject(db, id);
    return ok ? reply.send({ deleted: true }) : sendError(reply, 404, "NOT_FOUND", `主体不存在：${id}`);
  });

  // groups CRUD + 成员
  app.post("/v1/admin/groups", async (request, reply) => {
    await requireAdmin(request);
    const body = request.body as { name?: string };
    if (typeof body.name !== "string") return sendError(reply, 400, "BAD_REQUEST", "body 须含 name");
    return reply.send(await createGroup(db, body.name));
  });
  app.get("/v1/admin/groups", async (request, reply) => {
    await requireAdmin(request);
    return reply.send({ data: await listGroups(db) });
  });
  app.delete("/v1/admin/groups/:id", async (request, reply) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const ok = await deleteGroup(db, id);
    return ok ? reply.send({ deleted: true }) : sendError(reply, 404, "NOT_FOUND", `组不存在：${id}`);
  });
  app.post("/v1/admin/groups/:id/members", async (request, reply) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const body = request.body as { subjectId?: string };
    if (typeof body.subjectId !== "string") return sendError(reply, 400, "BAD_REQUEST", "body 须含 subjectId");
    await addGroupMember(db, id, body.subjectId);
    return reply.send({ added: true });
  });
  app.delete("/v1/admin/groups/:id/members/:subjectId", async (request, reply) => {
    await requireAdmin(request);
    const { id, subjectId } = request.params as { id: string; subjectId: string };
    await removeGroupMember(db, id, subjectId);
    return reply.send({ removed: true });
  });

  // read-grants CRUD
  app.post("/v1/admin/read-grants", async (request, reply) => {
    await requireAdmin(request);
    const state = await loadDefinition();
    const body = request.body as { subjectId?: string; groupId?: string; type?: string; predicate?: unknown };
    if (typeof body.type !== "string") return sendError(reply, 400, "BAD_REQUEST", "body 须含 type");
    return reply.send(await grantRead(db, state.definition, {
      subjectId: body.subjectId,
      groupId: body.groupId,
      typeApiName: body.type,
      predicate: body.predicate,
    }));
  });
  app.get("/v1/admin/read-grants", async (request, reply) => {
    await requireAdmin(request);
    return reply.send({ data: await listReadGrants(db) });
  });
  app.delete("/v1/admin/read-grants/:id", async (request, reply) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const ok = await revokeReadGrant(db, id);
    return ok ? reply.send({ deleted: true }) : sendError(reply, 404, "NOT_FOUND", `授权不存在：${id}`);
  });

  // action-grants CRUD
  app.post("/v1/admin/action-grants", async (request, reply) => {
    await requireAdmin(request);
    const body = request.body as { subjectId?: string; groupId?: string; action?: string };
    if (typeof body.action !== "string") return sendError(reply, 400, "BAD_REQUEST", "body 须含 action");
    return reply.send(await grantAction(db, { subjectId: body.subjectId, groupId: body.groupId, actionApiName: body.action }));
  });
  app.get("/v1/admin/action-grants", async (request, reply) => {
    await requireAdmin(request);
    return reply.send({ data: await listActionGrants(db) });
  });
  app.delete("/v1/admin/action-grants/:id", async (request, reply) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const ok = await revokeActionGrant(db, id);
    return ok ? reply.send({ deleted: true }) : sendError(reply, 404, "NOT_FOUND", `授权不存在：${id}`);
  });

  // tokens 三端点（spec 30 §4.3）
  app.post("/v1/admin/tokens", async (request, reply) => {
    await requireAdmin(request);
    const body = request.body as { subjectId?: string; subject?: string };
    let subjectId = body.subjectId;
    if (!subjectId && body.subject) {
      const found = await findSubjectByName(db, body.subject);
      if (!found) return sendError(reply, 404, "NOT_FOUND", `主体不存在（按名）：${body.subject}`);
      subjectId = found.subjectId;
    }
    if (typeof subjectId !== "string") return sendError(reply, 400, "BAD_REQUEST", "body 须含 subjectId 或 subject（名）");
    return reply.send(await issueToken(db, subjectId)); // 明文仅此一次
  });
  app.get("/v1/admin/tokens", async (request, reply) => {
    await requireAdmin(request);
    return reply.send({ data: await listTokens(db) });
  });
  app.delete("/v1/admin/tokens/:id", async (request, reply) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const ok = await revokeToken(db, id);
    return ok ? reply.send({ revoked: true }) : sendError(reply, 404, "NOT_FOUND", `token 不存在或已吊销：${id}`);
  });

  app.addHook("onClose", async () => {
    await pool.end();
    await db.destroy();
  });

  return app;
}
