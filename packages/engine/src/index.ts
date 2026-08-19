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
