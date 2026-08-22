/**
 * HTTP 错误映射 —— 引擎错误族 → 统一信封 `{error:{code,message,details?}}`
 * （spec 30 §6 映射表单一落点）。
 */
import type { FastifyError, FastifyReply } from "fastify";
import {
  AdminForbiddenError,
  AuthenticationError,
  BatchTooLargeError,
  GrantValidationError,
  IngestBadRequestError,
  IngestConflictError,
  IngestValidationFailedError,
  LinkRestrictedError,
  PermissionDenied,
  PreconditionFailedError,
  PushRejectedError,
  QueryValidationError,
  UnknownCallableError,
  UnknownParamError,
  UnknownTypeError,
  UniqueConflictError,
  ValidationFailed,
  WhitelistDeniedError,
} from "@heirloom/engine";

export function sendError(reply: FastifyReply, status: number, code: string, message: string, details?: unknown): FastifyReply {
  return reply.status(status).send({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
}

interface Mapped {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

function mapError(err: unknown): Mapped {
  if (err instanceof AuthenticationError) return { status: 401, code: "UNAUTHENTICATED", message: err.message };
  if (err instanceof WhitelistDeniedError) return { status: 403, code: "WHITELIST_DENIED", message: err.message };
  if (err instanceof PermissionDenied) return { status: 403, code: "PERMISSION_DENIED", message: err.message };
  if (err instanceof AdminForbiddenError) return { status: 403, code: "ADMIN_FORBIDDEN", message: err.message };
  if (err instanceof UnknownCallableError || err instanceof UnknownTypeError) {
    return { status: 404, code: "NOT_FOUND", message: err.message };
  }
  if (err instanceof UnknownParamError) return { status: 400, code: "BAD_REQUEST", message: err.message };
  if (err instanceof PreconditionFailedError) return { status: 409, code: "PRECONDITION_FAILED", message: err.message };
  if (err instanceof UniqueConflictError) {
    return { status: 409, code: "UNIQUE_CONFLICT", message: err.message, details: { constraint: err.constraint } };
  }
  if (err instanceof LinkRestrictedError) {
    return { status: 409, code: "LINK_RESTRICTED", message: err.message, details: { referencers: err.referencers } };
  }
  if (err instanceof QueryValidationError) {
    return { status: 422, code: "VALIDATION_FAILED", message: "查询体校验失败", details: { issues: err.issues } };
  }
  if (err instanceof ValidationFailed) {
    return { status: 422, code: "VALIDATION_FAILED", message: err.message, details: { fields: err.fields } };
  }
  if (err instanceof PushRejectedError) {
    const status = err.code === "BAD_REQUEST" ? 400 : 422;
    return { status, code: err.code, message: "本体推送被拒绝", details: { violations: err.violations } };
  }
  if (err instanceof BatchTooLargeError) return { status: 413, code: "BATCH_TOO_LARGE", message: err.message };
  if (err instanceof IngestConflictError) {
    return { status: 409, code: err.code, message: err.code === "UNIQUE_CONFLICT" ? "unique 冲突" : "required 链接阻删", details: { violations: err.violations } };
  }
  if (err instanceof IngestValidationFailedError) {
    return { status: 422, code: "VALIDATION_FAILED", message: err.message, details: { violations: err.violations } };
  }
  if (err instanceof IngestBadRequestError) {
    return { status: 400, code: "BAD_REQUEST", message: err.message, details: { issues: err.issues } };
  }
  if (err instanceof GrantValidationError) {
    return { status: 422, code: "VALIDATION_FAILED", message: err.message, details: { issues: err.issues } };
  }
  return { status: 500, code: "INTERNAL", message: "引擎内部错误" };
}

/** Fastify 全局错误处理：已知族映射信封；畸形 JSON 等框架错误 → 400 BAD_REQUEST */
export function errorHandler(err: FastifyError | unknown, _request: unknown, reply: FastifyReply): void {
  const fastifyErr = err as FastifyError;
  // 请求体畸形（非法 JSON / 空 body）→ 400，与 422 严格分立（spec 30 §2）
  if (fastifyErr && typeof fastifyErr === "object" && "statusCode" in fastifyErr && fastifyErr.statusCode === 400) {
    sendError(reply, 400, "BAD_REQUEST", "请求体畸形（非法 JSON 或结构不符）");
    return;
  }
  const mapped = mapError(err);
  if (mapped.status === 500 && err instanceof Error) {
    reply.log.error(err);
  }
  sendError(reply, mapped.status, mapped.code, mapped.message, mapped.details);
}
