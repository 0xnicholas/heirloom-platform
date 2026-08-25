# 总架构

> **范围**：DSL / 引擎 / 线上面三面总览与边界、技术栈与运行时（TS 全栈 + 单 Postgres）、部署形态鸟瞰。
> **不含**：各面内部语义（各专章）。
> **素材**：[ADR-0006](../adr/0006-language-and-runtime-selection.md)（#15 决议全文）；各 ADR 的物理前提。
> **待落位**：无。
> **验收线**：深规格（[#13](https://github.com/0xnicholas/heirloom-pro/issues/13) 决议：逐条规范性陈述、总表归 [90](90-appendix.md)）

## 1. 三面鸟瞰

```
本体 TS 源码（Git 仓库）──heirloom CLI 物化──▶ 定义 JSON ──PUT /admin/ontology──┐
                                                                              ▼
SDK/REST 消费者 ◀──HTTP──▶ 单进程 Node app（引擎） ◀──SQL──▶ 单 Postgres
                              ▲  动作 execute（用户 TS 函数）进程内活事务执行
服务账号/同步器 ──POST /admin/ingest──▶ 引擎写入通道 ──────────────────────────┘
```

| 面 | 职责 | 章 |
|---|---|---|
| **语言面**（TS DSL） | 本体/动作/queryFn 的定义语言；代码即配置，无声明式规则层/可视化编辑 | [10](10-language.md) / [20](20-actions.md) |
| **引擎** | 编译器 + 事务协调器：本体→DDL、过滤/谓词→SQL 全下推、事务协调；自身无内存计算 | [40](40-engine.md) |
| **线上面**（REST + SDK） | 对任意本体不变的通用端点 + 管理面；SDK 从本体源码同源编译 | [30](30-api.md) |

- 横切：安全（[50](50-security.md)，谓词编译进每个读取）、演化（[60](60-evolution.md)，push 收敛）、接入与部署（[70](70-operations.md)）。
- **本体是运行时定义而非部署物**：演化经 CLI push，不需要重启（[60](60-evolution.md) §1）。

## 2. 技术栈：TypeScript 全栈 + 单 Postgres（normative）

v1–v2 维持 TS 全栈（引擎 + SDK/DSL）+ 单 Postgres。依据 = 三条结构性耦合 + 一条负载判断：

1. **第一界面即 TS DSL**：Ontology-as-code 的行业形态是 TS（Palantir Functions/Actions 主语言同为 TS）；Java code-first DSL 只有 builder/注解两条路，形态笨重一个量级。
2. **动作 `execute`（用户 TS 函数）必须在引擎进程内、活事务中执行**：引擎换语言即须嵌双运行时 + 跨语言编组，活事务语义（RYW、同事务引用）恰靠同进程才成立（[20](20-actions.md) §6）。
3. **引擎负载 = 编译器 + 事务协调器**：DDL 生成、谓词/过滤/游标/count 全部编译下推 Postgres，批量 ≤1000——引擎自身几乎不做内存计算（[40](40-engine.md) §1）。
4. **Java 的核心优势落在 v1–v2 不存在的负载上**（引擎内重计算、真线程并发、大堆）；TS 承重件已被调研验证（Kysely 薄层无 codegen，适配运行时动态 schema；codegen 中心的 Prisma/jOOQ 反而不适配）。

- **被否**：Java（JVM）引擎——优势不咬合当前架构，且换语言连锁修订面远超收益。
- 重访条件四条（重计算/多租户/动作体非 JS/受众变 Java 群体）见 [90](90-appendix.md) §4；触发须新开 ADR。

## 3. 运行时与部署鸟瞰

- 单进程 Node app + 单 Postgres；无 HA、无分布式（边界外，[00](00-overview.md) §5）。
- 部署双形态：docker-compose（app+postgres）零配置默认 / `DATABASE_URL` 指外部托管 PG 同等正式（[70](70-operations.md) §6）。
- 引擎 schema 迁移随启动自动（advisory lock 防并发）+ `migrate-only` 逃生门（[70](70-operations.md) §7）。
- 升级 = runbook 级（停旧 → pg_dump → 换镜像），迁移只向前、配置仅环境变量（[70](70-operations.md) §8）。

---
*决策史：ADR-0006（TS 全栈四依据 + 被否 Java + 重访条件）、各 ADR 物理前提（单进程 TS：ADR-0002/0003）。*
