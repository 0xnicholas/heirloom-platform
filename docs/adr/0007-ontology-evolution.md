# ADR-0007：本体定义与演化

- **状态**：已接受（2026-08-19）
- **来源**：wayfinder 票 [#6 本体定义与演化](https://github.com/0xnicholas/heirloom-pro/issues/6)，父图 [#1](https://github.com/0xnicholas/heirloom-pro/issues/1)
- **输入**：[ADR-0001](0001-ontology-language-core-semantics.md)（status 钩子、additive 友好默认）、[ADR-0002](0002-storage-engine-mapping.md)（一类型一表、自研 DDL 生成器）、[ADR-0003](0003-action-semantics.md)（动作/queryFn 形态）、[ADR-0004](0004-minimal-security-model.md)（谓词联动义务移交）、[ADR-0005](0005-data-ingestion-deployment.md)（CLI 推送机制已定）、[#12 决议](https://github.com/0xnicholas/heirloom-pro/issues/12)（DSL 外形八项、反向派生 push 拒绝）
- **关系**：接住 ADR-0005 移交的演化语义与 ADR-0004 移交的谓词联动；60 章素材就此闭合。

## 背景

本体是运行时定义（ADR-0005 决议 7：`heirloom ontology apply` CLI 推管理端点，非部署物），但推什么、如何收敛、变更如何分类、存量数据与 SDK 怎么办、何时算 breaking，均未决议。两条迁移平面必须分清：引擎 schema 迁移（启动自动，ADR-0005）≠ 本体 DDL（push 时生成，本 ADR）。

## 决策

1. **权威模型 = 全量期望态 + 服务端权威**：CLI 在本地加载本体 TS 模块（Node 进程求值），提取注册表物化为**定义 JSON**（语言中性），整体 PUT 管理端点；服务端存当前生效定义 + 单调递增 **revision** + push 审计行。**被否**：增量 patch 协议（diff 归客户端、并发与幂等语义复杂）；Git 权威服务端镜像（ADR-0005 已否的挂载变体）。
2. **收敛执行 = diff + 单事务**：服务端 diff(当前, 期望) → 变更分类 → 生成 DDL + 元数据更新 + 引用校验，利用 Postgres 事务性 DDL 在**单事务**内全成全败；成功则 revision +1、落 push 审计行（主体、时间、revision 区间、逐类别变更计数）；期望态 == 当前 → no-op，不涨 revision。push 幂等：重复推同一期望态结果一致。
3. **变更分类学三档**（矩阵进规格 60 章，拒绝信息须给出路建议）：
   - **自动**：加对象类型 / 可选属性 / 可选链接 / struct；放宽（required→可选、扩 length、enum 加值）。
   - **数据校验**（尝试执行，数据不过即整事务拒绝）：删**空**类型/属性/链接（0 行→过）；加 unique（建索引扫存量）；收紧 range/length（全表校验）；加 required **带静态 default**（PG 11+ 元数据-only）；enum 删值且无存量引用。
   - **拒绝**：改标量类型（string→integer）；重命名 apiName（=删+加，数据不迁）；可选→required 无 default；enum 删值且有存量引用。
4. **v1 无迁移语言**：拒绝档的官方出路 = 既有通道——一次性动作（事务内改写）/ 接入端点重灌 / 外部同步器。**被否**：Prisma 式 migration 脚本文件（DSL 迁移语言整包进规格，与最小可用相悖）；`--allow-data-loss` 强制通道（一次性误操作即永久丢数据，与平台谨慎口径相悖）。
5. **status 生命周期 = 纯元数据**（ADR-0001 钩子落地）：`experimental` / `active`（默认）/ `deprecated` 三值；introspection 与管理 API 可见可改；**运行时零强制**（deprecated 仍可正常读写）；删除 deprecated 类型仍走三档矩阵；无 deprecation window / 自动广播机器。
6. **push 联动校验 = fail-closed**（ADR-0004 移交义务）：push 事务内校验全部引用——行级谓词引用被删属性 → 拒；动作 / queryFn 引用悬空类型/链接 → 拒。本体、动作、queryFn 是**同一 registry、同一次 push、同一事务**收敛的整体。
7. **对外兼容口径 = 无兼容机器**：SDK 的 TS 类型从本体源码仓库同源编译，服务端不签发 SDK；REST 消费者面向 apiName 契约。**「何时算 breaking」的公开定义 = 拒绝档清单**；自动档对既有读者向后兼容（新列可空、只增不减）。**被否**：API 版本协商（/v2/ 并行，多版本本体/谓词并行语义整包进规格）；弃用自动广播（与 status 纯元数据一致）。

## 后果

- 60 章（定义与演化）素材齐备，撰写就绪；S1（首版 push）/S10（演化小步）故事素材齐。
- push 端点的请求/响应编码与错误码（三档拒绝的分类编码）归 #10 的 30 章。
- DSL 需提供注册表物化出口（registry → 定义 JSON），#12 外形的自然延伸，实现细节归规格 10/60 章。
- 引擎实现要点：DDL 生成器须按三档分类分别生成（ALTER/INDEX/CHECK），并支持事务内探测（行数、引用计数）——进 40 章。
- 已知限制进附录：重命名不迁数据；可选→required 无 default 不可自动化；无降级（承 ADR-0005）。
