# Heirloom Platform

Self-hostable ontology platform: define your domain as code with a **TypeScript DSL**, get a governed read/write REST API, actions, and entity-level RBAC on top of a single Postgres.

> Implementation of the [Heirloom spec](https://github.com/0xnicholas/heirloom-pro/tree/main/docs/spec) (spec 01–90). The spec is the authority; this repo is the build.

## What it is (v1)

- **Data**: object types + first-class links + struct value types, defined in TS and pushed to the engine as a definition JSON (spec 10/60).
- **Actions**: functional actions = the only semantic write path, executed in-process inside one live transaction (read-your-writes, same-transaction references) (spec 20).
- **Logic**: read-only query functions as the v1 interface slot (spec 20 §11).
- **Security**: entity-level RBAC — type-level + row-predicate read grants compiled into SQL, action whitelists, static PATs (spec 50).
- **Surface**: one fixed REST endpoint set for any ontology + TS SDK; no UI in v1 (spec 30).

## Status

Milestone plan (scenario-anchored, spec 80 S0–S11):

- [x] **M1** — `@heirloom/dsl`: builders, registry, definition JSON materialization + frozen example ontology fixture
- [x] **M2** — engine core: system-schema migrations (advisory lock + migrate-only), push pipeline (diff → 3-tier classification → transactional DDL → revision/no-op) — S1/S10 green on real PG
- [ ] **M3** — read path: query-package compilation (filter/sort/keyset/include/count)
- [ ] **M4** — actions & functions: live-transaction executor, five edit ops, audit
- [ ] **M5** — security: subjects/groups/PATs, read grants + predicate compilation, silent narrowing
- [ ] **M6** — ingest & deployment: admin ingest, import batches, compose, migrate-only
- [ ] **M7** — closeout: evolution matrix full coverage, OpenAPI export, S0–S11 e2e

## Development

```bash
pnpm install
pnpm build
pnpm test
```

Node ≥ 22.18, pnpm. Tests run against a real Postgres via `HEIRLOOM_TEST_DATABASE_URL` (CI provides one).

## License

Apache-2.0
