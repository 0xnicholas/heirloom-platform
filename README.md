# Heirloom Platform

Self-hostable ontology platform: define your domain as code with a **TypeScript DSL**, get a governed read/write REST API, actions, and entity-level RBAC on top of a single Postgres.

> Implementation of the [Heirloom spec](./docs/spec) (spec 01–90). The spec is the authority; this repo is the build. **v1 complete** — all milestones M1–M8 landed, acceptance scenarios S0–S12 green end-to-end over real HTTP.
>
> Spec, [ADRs](./docs/adr), glossary ([CONTEXT.md](./CONTEXT.md)), [workbench spec](./docs/workbench-spec), and [legacy whitepapers](./docs/whitepapers) are maintained in-repo (merged from the archived `heirloom-pro` spec repo; historical wayfinder ticket/branch links still point there).

## What it is (v1)

- **Data**: object types + first-class links + struct value types, defined in TS and pushed to the engine as a definition JSON (spec 10/60).
- **Actions**: functional actions = the only semantic write path, executed in-process inside one live transaction (read-your-writes, same-transaction references) (spec 20).
- **Logic**: read-only query functions as the v1 interface slot (spec 20 §11).
- **Security**: entity-level RBAC — type-level + row-predicate read grants compiled into SQL, action whitelists, static PATs (spec 50).
- **Surface**: one fixed REST endpoint set for any ontology + TS SDK; no UI in v1 (spec 30). Static OpenAPI 3.1 document at `GET /v1/meta/openapi`.

## Status

Milestone plan (scenario-anchored, spec 80 S0–S12) — **all green**:

- [x] **M1** — `@heirloom/dsl`: builders, registry, definition JSON materialization + frozen example ontology fixture
- [x] **M2** — engine core: system-schema migrations (advisory lock + migrate-only), push pipeline (diff → 3-tier classification → transactional DDL → revision/no-op) — S1/S10 green on real PG
- [x] **M3** — read path: query-package compiler + executor (filter ops incl. one-hop link EXISTS, ≤3-key sort w/ PG null-order defaults, keyset cursor over mixed dirs/nulls, include ≤2 hops, count) — S9 green on real PG, predicate-injection seams ready for M5
- [x] **M4** — actions & functions: live-transaction executor (snapshot + sync ctx model, UUIDv7 pre-gen, RYW, link-as-move, If-Match optimistic lock) + write channel (flush dependency-ordered, constraint→ValidationFailed mapping, ingest-ready) + audit rows — S4/S5/S7/S8-delete green on real PG
- [x] **M5** — security: PAT lifecycle (hlk_, sha256-at-rest, instant revoke), admin bootstrap + isAdmin short-circuit, read grants (type-level + predicate w/ $ctx constants, OR-union, DENY-ALL silent narrowing via M3/M4 injection points), action whitelist, security log — S3/S6 green
- [x] **M6** — online surface + CLI: Fastify server (semantic 5-endpoint + admin 9-group, unified error envelope, definition cache), engine ingest pipeline (≤1000/tx, per-op violation attribution, import-batch audit incl. rolled-back), CLI (ontology apply via esbuild eval, import CSV→typed batches, migrate-only, admin 1:1), compose dual-form + Dockerfile — S0/S2/S11 green over real HTTP
- [x] **M7** — closeout: evolution matrix full-branch tests (enum-removal escalation, unique/range probes, required-with-default, struct shape validation, dangling-predicate linkage), static OpenAPI 3.1 export (route-parity asserted), S0–S11 e2e single-line over real HTTP, deployment runbook
- [x] **M8** — `@heirloom/sdk`: TS SDK with phantom-type projection from ontology source (typed filter/sort/include per the spec 40 §6 op matrix, action params, ref = UUID input), `assertSynced()` revision reconciliation (expected vs effective definition, first-divergence path), CLI HTTP client promoted into the SDK package; S12 green over a real socket

Test baseline: **dsl 29 + engine 119 + server 28 + cli 4 + sdk 6 = 186 green** against a real Postgres (SDK suite also gates compile-time negative cases via `tsc`).

## Packages

| Package | What |
|---|---|
| `@heirloom/dsl` | TS builders (`objectType`/`link`/`action`/`queryFn`/props), registry, definition-JSON materialization, free-identifier analysis |
| `@heirloom/example-ontology` | Frozen HR/project example ontology (spec 80 fixture) |
| `@heirloom/engine` | Migrations, push pipeline, query compiler, write channel, action executor, security, ingest — everything Postgres |
| `@heirloom/server` | Fastify app (semantic + admin surfaces) + OpenAPI export |
| `@heirloom/sdk` | TS SDK — typed REST client compiled from ontology source (phantom-type projection; `createSdk` / `assertSynced`) |
| `@heirloom/cli` | `heirloom` — ontology apply / import / migrate-only / admin (HTTP client shared with SDK) |

## Run it

### 1. Zero-config compose (spec 70 §6)

```bash
docker compose up -d          # app + postgres
# optional pre-set bootstrap credentials:
HEIRLOOM_BOOTSTRAP_ADMIN=user:admin-01 HEIRLOOM_BOOTSTRAP_TOKEN=hlk_your_preferred_token docker compose up -d
```

The server runs engine migrations on boot, bootstraps the first admin, and listens on `:3000`. `DATABASE_URL` is the only deployment abstraction — pointing it at an external Postgres is equally supported.

### 2. Push an ontology, then use the API

```bash
export HEIRLOOM_URL=http://127.0.0.1:3000
export HEIRLOOM_TOKEN=hlk_…   # bootstrap token, or mint one: see admin below

heirloom ontology apply ./packages/example-ontology/ontology.ts
# → 收敛完成：revision 1，{"auto":20,"dataValidation":2}

# 应用侧（TS SDK，类型从本体源码直推）：
# const sdk = createSdk({ url, token, ontology: await import("./ontology.js") });
# await sdk.assertSynced();
# sdk.objects.employee.query({ filter: { status: { eq: "active" } }, count: true });

curl -s -H "Authorization: Bearer $HEIRLOOM_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"filter":{"status":{"eq":"active"}},"count":true}' \
  $HEIRLOOM_URL/v1/objects/employee/query
```

### 3. Admin day-one (subjects / groups / grants / tokens)

```bash
heirloom admin tokens create --subject user:admin-01            # mint PAT (plaintext shown once)
heirloom admin subjects create --kind service --name svc:hr-sync
heirloom admin groups create --name hr
heirloom admin groups members add --group <groupId> --subject <subjectId>
heirloom admin read-grants create --group <groupId> --type employee                      # whole type
heirloom admin read-grants create --group <groupId> --type employee --predicate-json '{"status":{"eq":"active"}}'
heirloom admin action-grants create --group <groupId> --action hire-employee
heirloom admin action-grants create --subject <svcId> --action ingest                    # ingestion grant
heirloom admin tokens list
heirloom admin tokens revoke --id <tokenId>
```

### 4. Bulk ingest from CSV (client-side conversion, spec 70 §3)

```bash
heirloom import employees.csv --type employee --source hr-sync
# CSV → typed batches (≤1000/req, decimal kept as string per meta) → POST /v1/admin/ingest
```

## Configuration (env only — 12-factor, spec 70 §8)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — (required) | Postgres connection string |
| `PORT` | `3000` | HTTP listen port |
| `HEIRLOOM_BOOTSTRAP_ADMIN` | — | first admin subject name (idempotent) |
| `HEIRLOOM_BOOTSTRAP_TOKEN` | — | optional bootstrap PAT value (`hlk_…`, stored hashed) |
| `HEIRLOOM_ACTION_TIMEOUT_MS` | `30000` | action transaction timeout (spec 20 §6) |
| `HEIRLOOM_SKIP_MIGRATE` | — | `1` = app holds no DDL (split deployment) |
| `HEIRLOOM_URL` / `HEIRLOOM_TOKEN` | — / — | CLI defaults |

## Deployment

Two supported topologies, same image (spec 70 §6–§7):

- **Zero-config compose** (`docker-compose.yml`): app + postgres, migrations on boot.
- **Split accounts** (`docker-compose.split.yml`): `migrate` service (DDL-privileged) runs `heirloom migrate-only` first; `app` runs with `HEIRLOOM_SKIP_MIGRATE=1`. Use for managed/locked-down Postgres.

**Upgrade runbook** (spec 70 §8): stop old app → `pg_dump` backup → start new image (engine migrations run automatically, or run `migrate-only` first). Migrations are forward-only; there is no downgrade path.

**Ontology is not a deployment artifact** — the only entry is `heirloom ontology apply` (push); evolution needs no restart (spec 60 §1/§8, 70 §8).

## API surface

Fixed for any ontology (spec 30): semantic five (`POST /v1/objects/{type}/query`, `GET /v1/objects/{type}/{id}` w/ include + If-Match, `POST /v1/actions/{name}/invoke`, `POST /v1/functions/{name}/invoke`, `GET /v1/meta/ontology`) + admin nine groups under `/v1/admin/*` (ontology push, ingest, audit, security-log, subjects, groups, read-grants, action-grants, tokens). Machine-readable: `GET /v1/meta/openapi` (static 3.1 doc; per-ontology generation → v2).

Error envelope `{error:{code,message,details?}}`; the error-code registry's single authority is [spec 90 §1](./docs/spec/90-appendix.md). Zero-authorization reads return `200 {data:[]}` — never 403 (silent narrowing).

**Recommended per-table soft limits** (advisory, not enforced — spec 40 §2): keep object types at **≤ 100 scalar properties** and row width in the **low single-digit KBs**; wider/deeper payloads belong in `struct`/`json` columns (TOAST-compressed). Beyond these, index and TOAST behavior degrade before correctness does — restructure the type rather than push the limit.

## Development

```bash
docker run -d --name heirloom-test-pg -e POSTGRES_USER=heirloom -e POSTGRES_PASSWORD=heirloom \
  -e POSTGRES_DB=heirloom_test -p 5433:5432 postgres:17   # local test PG (optional; see env below)
pnpm install
pnpm build
pnpm test
```

Node ≥ 22.18, pnpm. Integration tests need a real Postgres via `HEIRLOOM_TEST_ADMIN_URL` (defaults to `localhost:5433/postgres`; CI provides one on 5432). Each test file creates and drops its own throwaway database.

## License

Apache-2.0
