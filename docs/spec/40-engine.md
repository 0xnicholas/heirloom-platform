# 存储引擎

> **范围**：本体→物理 schema 映射、约束物理承载、链接物理结构、删除语义、对象 ID、查询编译与查询包、分页与联取、实时读取模式、写事务与并发控制。
> **不含**：API 线上编码（[30](30-api.md)）；DDL 生成与变更分类（[60](60-evolution.md)）；部署与迁移执行（[70](70-operations.md)）；行级谓词注入（[50](50-security.md)）。
> **素材**：ADR-0002（存储映射七决策）、ADR-0001（类型系统）、[research/ts-postgres-stack](https://github.com/0xnicholas/heirloom-pro/blob/research/ts-postgres-stack/research/ts-postgres-stack.md)（Kysely/RLS 依据）。
> **待落位**：无。
> **验收线**：深规格（[#13](https://github.com/0xnicholas/heirloom-pro/issues/13)：逐条规范性陈述、总表归 [90](90-appendix.md)）

## 1. 总则

引擎 = 单 Postgres 上的**编译器 + 事务协调器**：本体→DDL 生成、过滤/谓词→SQL 编译、全部下推执行；引擎自身无内存计算。查询层用 Kysely（薄层、无 codegen——适配运行时动态 schema；Prisma/jOOQ 类 codegen 中心方案不适用）。行级权限在应用层注入编译（RLS 仅作纵深防御可选层，非依赖项）。

## 2. 对象表映射（一类型一表·属性即列）

| 语言构造 | 物理列 | 备注 |
|---|---|---|
| `string` | `text` | |
| `boolean` | `boolean` | |
| `integer` | `bigint` | 覆盖 ±2^53 |
| `float` | `double precision` | |
| `decimal` | `numeric` | 任意精度 |
| `date` / `datetime` | `date` / `timestamptz` | |
| `enum` | `text` + `CHECK (col IN (...))` | |
| `struct`（含嵌套） | 单个 `jsonb` 列 | 引擎校验形状 |
| `json` | `jsonb` | 逃生舱 |
| 数组 | 原生数组列（`struct[]` → `jsonb`） | |

约束承载：`required` → `NOT NULL`；`range` / `length` / `regex` → `CHECK`；`unique` → `UNIQUE`。系统列：`id`（UUIDv7 主键）、`created_at`、`updated_at`（每次写刷新——水位线同步的锚）。

- 约束**必须**由 Postgres 原生承担（统计质量、无表达式索引体操、属性级更新无 TOAST 全值重写）。
- 每表属性数/行宽**应当**设软上限建议（TOAST 与表宽考量；具体建议值随实现定，规格锁「存在建议」）。

## 3. 链接物理结构

| 基数 | 结构 | 语义 |
|---|---|---|
| `1:1` / `1:N` | N 侧外键列（`1:1` 另加 `UNIQUE`） | 声明真实 `FOREIGN KEY` |
| `M:N` | 每条链接一张独立链接表，`(from, to)` 主键 | **集合语义**（同一对不重复） |

- 引用完整性由 DB 外键强制；链接无载荷（承 [10](10-language.md)）。

## 4. 删除语义

| 情形 | 行为 |
|---|---|
| 被 **required** 链接引用 | **不可删**（`ON DELETE RESTRICT`）；API 返回 409 并列出引用方 |
| 被 optional 链接引用 | 可删：`1:1`/`1:N` 外键 `SET NULL`；`M:N` 链接行 `CASCADE` |
| FK 持方自身删除 | 无额外动作 |

- v1 为**硬删除**；无 API 级联删除选项（→ v2）。

## 5. 对象 ID

**UUIDv7，应用层生成**：事务开始前 id 已存在（动作同事务引用新建对象的根基）；时序有序（B-tree 顺序插入 + keyset 游标锚）。实现**必须**选带单调计数位的库（防同毫秒乱序）；具体库为实现细节，不进规格。

## 6. 查询包（v1 精干集）

过滤算子（大小写敏感，Postgres `LIKE` 语义）：`eq` / `neq` / `in` / `gt` / `gte` / `lt` / `lte` / `contains` / `startsWith` + null 检查；`and` / `or` / `not` 任意嵌套；数组 `contains-any`。

- 过滤与排序**仅限**当前类型属性 + **一跳链接属性**；多键排序 ≤3 键；null 排序随 Postgres 默认（ASC NULLS LAST / DESC NULLS FIRST）并写入文档。
- 分页：**keyset 游标**（排序键 + id 锥）；`limit` 默认 100、上限 1000。
- 聚合：仅 `count`（同过滤器）。
- 联取：`include` 链式最深 **2 跳**。
- 跨类型查询、全文检索、按链接属性排序 → v2（[90](90-appendix.md)）。

## 7. 实时读取

v1 **无推送**（LISTEN/NOTIFY 与 WebSocket 因 PgBouncer 事务池化不兼容 + 连接态成本，显式推迟）。

- 规格**必须**文档化同步模式：**水位线 + 游标增量拉取**（按 `updated_at` 轮询拉增量）。
- **删除不可轮询**（无墓碑快照）——文档明示；变更数据流 → v2。

## 8. 写事务与并发

- **单请求 = 单 DB 事务**，全有或全无（含同请求改对象 + 改链接、批量写入）。
- 批量上限 **1000** 对象/请求；任一条违约束 → 整批回滚 + 违规条目清单。
- 并发控制：更新**可选** `If-Match`（锚 `updated_at`）——命中旧值 409；缺省最后写入胜（LWW）。`unique` 冲突 → 409 带约束标识。
- 部分成功/逐项提交 → 动作层语义（[20](20-actions.md)）或 v2。

## 9. 行级谓词注入点

读授权谓词（[50](50-security.md)）**编译进每个对象读取 SELECT** 的 WHERE 片段——主查询、include、count、游标一致；谓词词汇 = 本查询包算子 + `ctx` 常量（同源复用）。RLS 纵深防御为部署可选项，规格不依赖。

## 10. 已知限制与 v2（详见 [90](90-appendix.md)）

跨类型查询/全文/链接属性排序缺席；无推送（水位线轮询）；删除不可轮询；行宽软上限待实现定值。

---
*决策史：ADR-0002（七决策）、ADR-0001（类型系统）、#4 research（Kysely/RLS 依据；其「通用表+jsonb」子项已被 ADR-0002 推翻）。*
