# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-08-26

First tagged release. v1 scope complete per spec 01–90: milestones M1–M8, acceptance scenarios S0–S12 green end-to-end over real HTTP against a real Postgres.

### Added — M8: `@heirloom/sdk` (spec 30 §1, ADR-0009)

- **Typed REST client compiled from ontology source** (`createSdk({ url, token, ontology })`): object shapes, the closed filter-op set (mirroring the spec 40 §6 engine matrix per scalar kind), sort keys (≤3), include paths (≤2 hops) with cardinality-aware mounting (single → object|null, multi → array), action/function invoke params (ref = UUID input), and execute return-type projection — zero codegen, phantom-type projection only.
- **Revision reconciliation** (`assertSynced()`): materializes the local expected state, canonical-compares against the server's effective definition (`GET /v1/meta/ontology`); returns `{revision}` on match, throws `OntologyDriftError` with server revision + first-divergence path otherwise.
- SDK surface = semantic five endpoints + reconciliation; admin stays with the CLI (spec 30 §7). CLI HTTP client promoted into the SDK package (CLI is now a thin shell over the same runtime).
- Acceptance scenario **S12** added to spec 80 (compile-time negative cases gated via `tsc`; HTTP smoke over a real socket). Coverage matrix now closes ADR-0008 decision 1 and ADR-0009.
- ADR-0009 records the phantom-projection-over-codegen decision and its accepted weak spots (self-link `(): any` thunks, reverse-link includes, excess-property checking under generic `const` inference).

### Fixed

- DSL phantom typing: `prop.integer()` / `prop.float()` projected the literal type `"number"` instead of `number` (latent; surfaced by SDK type projection).

### Pre-history (0.x, 2026-08)

- M1–M7 per README milestone plan: DSL builders & registry; engine (migrations, push pipeline, query compiler, live-transaction action executor, write channel, entity-level RBAC, PAT security); Fastify server (semantic + admin surfaces, static OpenAPI 3.1); CLI (`ontology apply` / `import` / `migrate-only` / `admin`); compose dual-topology + Dockerfile; evolution-matrix full-branch tests; S0–S11 e2e.
