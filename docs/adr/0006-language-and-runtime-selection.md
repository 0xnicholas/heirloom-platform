# ADR-0006：语言与运行时选型（TypeScript 全栈）

- **状态**：已接受（2026-08-19）
- **来源**：wayfinder 票 [#15 语言选型复审：TypeScript 全栈还是 Java](https://github.com/0xnicholas/heirloom-pro/issues/15)，父图 [#1](https://github.com/0xnicholas/heirloom-pro/issues/1)
- **输入**：[ADR-0002](0002-storage-engine-mapping.md)、[ADR-0003](0003-action-semantics.md)、[ADR-0004](0004-minimal-security-model.md)、[ADR-0005](0005-data-ingestion-deployment.md)（技术栈作为物理前提的全部用法）、[#4 调研：TS+Postgres 技术栈选型依据](https://github.com/0xnicholas/heirloom-pro/issues/4)（[research/ts-postgres-stack.md](https://github.com/0xnicholas/heirloom-pro/blob/research/ts-postgres-stack/research/ts-postgres-stack.md)）、[#12 TS DSL 外形原型](https://github.com/0xnicholas/heirloom-pro/issues/12)
- **关系**：把建图根决策「技术栈=TypeScript 全栈 + Postgres」升格为有依据、有重访条件的正式决议；不改变任何已决票结论，只补上它们共同依赖而未被正面决议过的前提。

## 背景

技术栈在建图会话锁定为根决策，但从未有专属决议票：[#4](https://github.com/0xnicholas/heirloom-pro/issues/4) 只在 TS 之内调研（ORM/动态属性/权限执行点），ADR-0002/0003 更把「单进程 TS 全栈」当作物理前提写进推理。规格终点要求「架构与选型全部锁定，无遗留决策」，故正面复审：**长期来看 TypeScript 是否仍是正确选择？为什么不是 Java？**

## 决策

**Heirloom v1–v2 维持 TypeScript 全栈（引擎 + SDK/DSL）+ 单 Postgres。** 依据 = 三条结构性耦合 + 一条负载判断：

1. **第一界面即 TS DSL**（根决策；#12 原型在飞）。Ontology-as-code 的行业形态是 TypeScript——Palantir Foundry 的 Functions/Actions 主语言同为 TS。Java 做 code-first DSL 只有 builder/注解两条路，形态笨重一个量级。
2. **ADR-0003 要求动作 `execute`（用户 TS 函数）在引擎进程内、活事务中执行**。引擎若换 Java：动作体仍是用户 TS，必须嵌 GraalJS 双运行时 + `ctx`/对象跨语言编组——每个动作付编组税，而活事务语义（RYW、同事务引用）恰靠同进程才成立。
3. **引擎真实负载是「编译器 + 事务协调器」**（ADR-0002/0004）：本体→DDL 生成、谓词/过滤/游标/count 全部编译下推 Postgres，批量 ≤1000，引擎自身几乎不做内存计算。
4. **Java 的核心优势恰好落在 v1–v2 不存在的负载上**（引擎内重计算、真线程并发、大堆）；而 TS 侧承重件已被 #4 验证——Kysely 薄层无 codegen 适配运行时动态 schema，codegen 中心的 Prisma/jOOQ 反而不适配。自部署 footprint（ADR-0005 compose 双形态：Node 容器小、冷启动快）与开源贡献者池（写 TS DSL 的开发者与引擎贡献者重合）亦偏向 TS。

**被否：Java（JVM）引擎。** 承认其优势——计算密度、数据基础设施生态（JDBC/jOOQ/流处理）、企业级长期维护池——但每条都不咬合当前架构；且换语言的连锁修订面（#10、#12 与 ADR-0002~0005 全部「单进程 TS」表述）远超收益。

## 重访条件

出现以下任一信号时重开语言选型（届时更可能是「Postgres 旁加计算层」而非「引擎换语言」）：

1. 引擎内出现重计算需求（分析查询、大规模内存处理）；
2. 多租户 SaaS 规模（当前 out of scope）；
3. 动作体改用非 JS 语言定义；
4. 目标受众变为 Java 企业开发群体。

## 后果

- 规格技术栈章节直接引用本 ADR；「选型全部锁定」清单勾掉语言与运行时项。
- #12（TS DSL 原型）与 #10（API 形态）的前提由本 ADR 背书，无需改动。
- 未来若触发重访条件，须新开 ADR 评估并连锁修订本 ADR 与受影响决议。
