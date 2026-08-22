export * from "./naming.js";
export { createDb, runMigrations, migrateOnly } from "./system-schema.js";
export type { EngineDatabase } from "./system-schema.js";
export { diffOntology, sameDefinition, canonical, describeChange } from "./changes.js";
export type { Change } from "./changes.js";
export { classifyChange, classifyAll } from "./classify.js";
export type { Tier, ClassifiedChange } from "./classify.js";
export { buildOps } from "./ddl.js";
export type { Op, SqlOp, ProbeOp } from "./ddl.js";
export { pushOntology, PushRejectedError } from "./push.js";
export type { PushActor, PushResult, PushViolation } from "./push.js";
export {
  compileQuery,
  executeQuery,
  compileFilterFragment,
  decodeRow,
  pgExec,
  QueryValidationError,
  UnknownTypeError,
} from "./query.js";
export type {
  FilterNode,
  SortSpec,
  QueryRequest,
  QueryResult,
  QueryIssue,
  PredicateByType,
  CompiledStatement,
  CompiledQuery,
  CompiledIncludeHop,
  ResolvedSortKey,
  CompileQueryOptions,
  SqlExec,
} from "./query.js";
export { WriteChannel, validatePropValue, constraintToValidationFailed, WriteOpError } from "./write.js";
export type { EditRecord, LinkPhysical, ResolvedLink } from "./write.js";
export { ValidationFailed, PermissionDenied } from "@heirloom/dsl";
export {
  PreconditionFailedError,
  UniqueConflictError,
  LinkRestrictedError,
} from "./write.js";
export {
  invokeAction,
  invokeFunction,
  buildExecute,
  UnknownCallableError,
  UnknownParamError,
} from "./execute.js";
export type { InvokeActor, InvokeOptions, InvokeActionResult } from "./execute.js";
export {
  AuthenticationError,
  WhitelistDeniedError,
  AdminForbiddenError,
  GrantValidationError,
  issueToken,
  issueTokenWithValue,
  revokeToken,
  listTokens,
  authenticate,
  bootstrapAdmin,
  createSubject,
  listSubjects,
  findSubjectByName,
  updateSubject,
  deleteSubject,
  createGroup,
  listGroups,
  deleteGroup,
  addGroupMember,
  removeGroupMember,
  grantRead,
  revokeReadGrant,
  listReadGrants,
  grantAction,
  revokeActionGrant,
  listActionGrants,
  assembleReadPredicates,
  checkActionAllowed,
  checkIngestAllowed,
  INGEST_GRANT_ACTION,
  assertAdmin,
  logSecurityEvent,
  resolveCtxConstants,
  listAudit,
  listSecurityLog,
  DENY_ALL,
} from "./security.js";
export type {
  AuthContext,
  ReadGrantInput,
  ActionGrantInput,
  SecurityEvent,
  SubjectHandle,
  SubjectRow,
  GroupRow,
  ReadGrantRow,
  ActionGrantRow,
  AuditRow,
  SecurityLogRow,
  ListFilters,
} from "./security.js";
export {
  ingestBatch,
  IngestBadRequestError,
  BatchTooLargeError,
  IngestConflictError,
  IngestValidationFailedError,
} from "./ingest.js";
export type {
  IngestOperation,
  IngestCreateOp,
  IngestModifyOp,
  IngestDeleteOp,
  IngestActor,
  IngestViolation,
  IngestResult,
} from "./ingest.js";
