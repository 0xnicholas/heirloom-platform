# ADR-0002：存储引擎映射（v1）

- **状态**：已接受（2026-08-16）
- **来源**：wayfinder 票 [#7 存储引擎映射](https://github.com/0xnicholas/heirloom-pro/issues/7)，父图 [#1](https://github.com/0xnicholas/heirloom-pro/issues/1)
- **输入**：[research/ts-postgres-stack](https://github.com/0xnicholas/heirloom-pro/tree/research/ts-postgres-stack)（#4）、[ADR-0001](0001-ontology-language-core-semantics.md)（#5）、[research/oss-landscape](https://github.com/0xnicholas/heirloom-pro/tree/research/oss-landscape)（#3）
- **关系**：**部分推翻** research #4 的 D2 推荐（通用对象表 + jsonb）——其 Kysely（D1）与行级权限应用层注入（D3）结论维持不变

## 背景

Heirloom 的对象类型由用户在运行时定义（ADR-0001），引擎须把本体语义映射到 Postgres 物理结构。#4 调研曾推荐通用对象表 + `properties jsonb` + 选择性索引（动机是避开 DDL）；ADR-0001 的后果段预判一类型一表；#3 的开源对比指向 OpenMetadata 的一类型一表 + 中央关系表。本 ADR 锁定七个决策点，消解三方张力。

## 决策

1. **一类型一表·属性即列（原生映射）**：每个对象类型一张表；每个属性一个原生类型列——`integer`→`bigint`（覆盖 ±2^53）、`float`→`double precision`、`decimal`→`numeric`、`date`/`datetime`→`date`/`timestamptz`、`enum`→`text` + CHECK、`struct`→单个 `jsonb` 列（引擎校验，可嵌套）、`json`→`jsonb`、数组→原生数组列（`struct[]`→jsonb）。`required`→`NOT NULL`；`range`/`length`/`regex`→`CHECK`；`unique`→`UNIQUE`。
   **理由**：本体语言约束丰富，原生映射让 Postgres 直接承担约束与统计（免表达式索引/部分索引体操）；属性级更新无 TOAST 全值重写；且引擎本来就必须自研「本体→DDL」生成器（索引声明同样要 DDL），通用表「零 DDL」的优势并不成立。
   **被否方案**：通用对象表+jsonb（jsonb 统计质量存疑、部分索引要求内联类型字面量、>2KB 属性集每改一键全值重写）；一类型一表+属性打包 jsonb（折中，但约束与统计仍靠应用层）。
2. **链接物理映射**：`1:1`/`1:N` → N 侧外键列（`1:1` 另加 `UNIQUE`）；`M:N` → 每条链接一张独立表，`(from, to)` 主键——**集合语义**（同一对不重复）。全部声明真实 `FOREIGN KEY` 约束，引用完整性由 DB 强制。链接无载荷（承袭 ADR-0001）。
3. **删除语义**：被 **required** 链接引用的对象不可删（`ON DELETE RESTRICT`；API 返回 409 并列出引用方）；被 **optional** 链接引用的可删——`1:1`/`1:N` 外键 `SET NULL`，`M:N` 链接行 `CASCADE`；FK 持方自身删除无额外动作。v1 为硬删除（审计归 #8）；**不提供** API 级联删除选项（v2 再议）。
4. **对象 ID**：**UUIDv7，引擎应用层生成**。事务开始前 id 已存在，便于「建对象+建链接」同事务引用；时序有序带来 B-tree 顺序插入与游标分页锚。实现须选带单调计数位的库，防同毫秒乱序。
5. **查询能力（精干 v1 包）**：过滤算子 `eq`/`neq`/`in`/`gt`/`gte`/`lt`/`lte`/`contains`（**大小写敏感**，LIKE 语义）/`startsWith` + null 检查；`and`/`or`/`not` 任意嵌套；数组 `contains-any`。**过滤与排序仅限当前类型属性 + 一跳链接属性**；多键排序 ≤3 键；null 排序随 Postgres 默认（ASC NULLS LAST / DESC NULLS FIRST）并写入文档。分页：**keyset 游标**（排序键 + id 锥），`limit` 默认 100、上限 1000。聚合：仅 `count`（同过滤器）。联取：`include` 链式最深 **2 跳**。跨类型查询、全文检索、按链接属性排序——v2。
6. **实时读取**：v1 **无推送**。引擎为每表维护 `updated_at`（每次写刷新）；规格文档化「水位线 + 游标增量拉取」同步模式。删除不可轮询（无快照）——文档明示；变更数据流 → v2。LISTEN/NOTIFY 与 WebSocket 因 PgBouncer 事务池化不兼容 + 连接态成本，显式推迟。
7. **写入事务**：**单请求 = 单 DB 事务**，全有或全无（含同请求内改对象+改链接、批量写入）；批量上限 **1000** 对象；任一条违约束 → 整批回滚 + 违规条目清单。并发控制：更新**可选** `If-Match`（以 `updated_at` 为锚）——命中旧值 409；缺省最后写入胜（LWW）。`unique` 冲突 → 409 带约束标识。部分成功/逐项提交 → 动作层（#8）或 v2。

## 后果

- #4 记录中「通用表 + jsonb」子项**作废**；Kysely 查询层、行级权限应用层注入维持。
- 本体演化（#6）全部经由引擎生成的 DDL：加可空列免表重写（PG11+）；改类型/收紧约束可能触发表重写——演化安全策略归 #6，本 ADR 只提供物理事实。
- jsonb 仅剩 struct 嵌套值与 `json` 逃生舱列在用——#4 遗留的「jsonb planner 统计待验证」风险面收窄至 struct 查询。
- #10（API 形态）拿到输入：filter/sort/cursor/include/If-Match 的线上编码格式；#8（动作语义）拿到：多对象原子事务原语；**#11（数据接入与部署）解除阻塞**。
- 规格撰写时需补：单行属性集/列数软上限建议（TOAST 与表宽）；UUIDv7 具体库为实现细节，不进规格。
