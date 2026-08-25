# ADR-0003：动作语义（v1）

- **状态**：已接受（2026-08-16）
- **来源**：wayfinder 票 [#8 动作语义](https://github.com/0xnicholas/heirloom-pro/issues/8)，父图 [#1](https://github.com/0xnicholas/heirloom-pro/issues/1)
- **输入**：[research/palantir-ontology](https://github.com/0xnicholas/heirloom-pro/tree/research/palantir-ontology)（#2，含 2026-08-16 Ontology system 页补充精读）、[ADR-0001](0001-ontology-language-core-semantics.md)（#5）、[ADR-0002](0002-storage-engine-mapping.md)（#7）
- **关系**：兑现 ADR-0001「动态默认归动作层」的欠账；消费 ADR-0002 的单事务原语与 UUIDv7 预生成；#9/#10 拿到边界输入

## 背景

Palantir 的动作机制分两套：声明式规则（元数据里配 create/modify/upsert/delete 规则，无代码）与函数式动作（TS 函数 + 编辑批次）；外加独立的 submission criteria 声明层、编辑折叠器（每对象单一 edit）、禁止引用本事务新建对象等约束。这些机制多数为分布式规则执行与 UI 可配置治理而生。Heirloom 是单进程 TS 全栈 + 单 Postgres、v1 无 UI、TS DSL 即配置面——本 ADR 在此物理事实上裁剪动作语义，并对每处与 Palantir 的偏离明示理由。

## 决策

1. **仅函数式动作**：动作 = 命名 + 类型化参数 + `execute` 函数（TS），服务端进程内执行。不设声明式规则分类学（create/modify/upsert/delete 规则配置）。权限、审计、校验只挂在动作边界。**理由**：v1 无 UI，规则分类学的价值主要在 UI 可配置治理；TS DSL 本来就是 code-first，代码即配置。**被否**：声明式规则（无代码执行但表达力受限）；两套都要（规格面超重）。
2. **参数模型**：九类标量（含数组变体）+ struct（复用形状）+ 对象引用（传 UUID，引擎在 `execute` 前预取并注入完整对象；不存在 → 结构化校验失败）。默认值：静态字面量或 `(ctx) => value` 动态函数（兑现 ADR-0001 欠账）。无 hidden 参数、无对象集参数（→ 查询/函数层）。
3. **校验契约**：无声明式 criteria 层；动态校验在 `execute` 内做，抛结构化 `ValidationFailed`（逐字段消息）。语义契约保留 Palantir 的「校验结果在响应体、逐参数可区分」；HTTP 状态码映射归 #10。user 类条件（当前用户身份）划归 #9 动作权限。**理由**：单事务下 execute 失败自动回滚，criteria 的隔离价值消失；元数据内省损失接受（v2 再补）。
4. **编辑操作面**：五操作 `create` / `modify` / `delete` / `link` / `unlink`。链接操作**全基数统一**（引擎内部翻译为 1:1/1:N 的列更新或 M:N 的链接表行，函数作者无感）。无 upsert（unique 冲突 → 409 语义，需要时显式查-改/建两步）。**理由**：ADR-0001 链接一等且无外键属性概念，Palantir 的链接劈分（M:N 用 link 操作、1:1/1:N 绕道改外键属性）无处安放。
5. **活事务**：`execute` 全程处于同一 DB 事务——read-your-writes（读得到自己已写）、可引用本事务新建对象（UUIDv7 事务前预生成，ADR-0002 已预留）、顺序写后写自然胜出；正常返回即 COMMIT，抛错（含 `ValidationFailed`）即 ROLLBACK。**无编辑折叠器、无禁止清单**（delete-before-add / double-create 等禁令不设）。**理由**：折叠与禁令为分布式规则编译而生，单事务顺序 SQL + Postgres 约束即真相。心智模型：动作 = 一个事务里跑的函数。
6. **效应边界**：v1 动作事务内唯一效应 = 写本体（对象表即权威态）。无副作用规则（webhook/notification）、无外部系统写回、多步编排一律压缩为单事务单请求——三者显式推迟 v2（对齐 Ontology system 页「写回运营/边缘系统」的动作支柱定位，但 v1 显式画线）。
7. **动作与函数的编排**：v1 运行时无注册函数调用桥；`execute` 内复用逻辑 = 普通 TS import（代码组合，无治理概念）；「注册函数」仅作为 #10 的只读查询 API 接口位。动作↔注册函数调用桥与安全作用域叠加 → v2。**理由**：与根决策「逻辑只留接口位」最字面一致，作用域叠加问题 v1 消失。
8. **并发与重试**：`ctx.modify` 可选传 `expectedUpdatedAt`（复用引擎 If-Match 语义，锚 `updated_at`；命中旧值 → 冲突，整个事务回滚）。无幂等键；重试语义写入规格：网络超时后盲重可能双花，带 `expectedUpdatedAt` 重试安全，业务键 `unique` 约束天然拼升幂等。**被否**：Idempotency-Key + 结果缓存（需键作用域/保留窗口/逐出语义，v1 不值其规格成本）。
9. **审计日志**：同库只追加表，每个**已提交**动作一行：动作 apiName、时间戳、主体、入参（默认值填充后原样记录；自部署单租户不设脱敏机制——已知限制，入规格）、结果编辑集（逐对象 type+id+op）、`expectedUpdatedAt` 是否使用、事务 id、耗时。INVALID 尝试不落审计（回滚 = 无事发生）；认证/授权拒绝记录归 #9。查询：只读管理端点，复用引擎过滤包（线上编码归 #10）。保留：v1 不主动清理。

附：动作事务设超时上限（建议默认 30s，可配置），超时即回滚——防长事务持锁。具体值为实现细节，规格只锁「存在上限」。

## 与 Palantir 的对齐 / 偏离

| 机制 | Palantir | Heirloom v1 | 理由 |
|---|---|---|---|
| Action = 显式动词、单事务多对象 | ✓ | ✓ 对齐 | 核心定位 |
| 校验结果在响应体、逐参数区分 | ✓ | ✓ 对齐（语义层） | 有价值的契约；HTTP 编码归 #10（可能 422 而非 200+INVALID） |
| 函数写必须包装成 action | ✓ | ✓ 更强：语义层写路径**只有**动作 | 统一权限/审计挂点 |
| 声明式规则分类学 | ✓ | ✗ 偏离 | 无 UI；代码即配置 |
| submission criteria 层 | ✓ | ✗ 偏离 | 单事务隔离价值消失；内省损失接受 |
| 链接编辑劈分（M:N link / 1:1、1:N 改外键） | ✓ | ✗ 偏离：全基数统一 link/unlink | 链接一等，无外键属性概念 |
| 禁止引用本事务新建对象 | ✓ | ✗ 偏离：允许 | UUIDv7 事务前预生成 |
| 无 read-your-writes | ✓ | ✗ 偏离：有 RYW | 单事务自然语义 |
| 编辑折叠为每对象单一 edit | ✓ | ✗ 偏离：无折叠器 | 分布式问题不存在 |
| 副作用规则 / 外部写回 / 多步编排 | ✓ | ✗ v2 | 最小可用 + 单 Postgres |
| 动作编排注册函数（decision graph） | ✓ | ✗ v2 | 逻辑只留接口位 |

## 后果

- #9（安全模型）拿到输入：动作权限边界（user 类条件全归 #9）、审计主体模型、认证/授权拒绝是否记录及记什么；参数不脱敏的已知限制移交 #9 评估敏感面。
- #10（API 形态）拿到输入：`ValidationFailed` 的线上编码、动作 apply 端点形状（含 `expectedUpdatedAt` 传递）、只读注册函数接口位、审计查询端点编码。
- #11（数据接入）：批量导入走引擎写入通道（ADR-0002），不经动作；动作内单事务无批量上限减免（受 1000 上限约束）。
- 请求内多动作提交（部分成功语义）未提供——单请求单动作；批量提交的逐项结果 → v2。
- 规格撰写时需写明：重试语义（决议 8）、超时上限存在性、审计不脱敏限制。
- 动作 DSL 外形（`action({...})`、`ctx.*`、`ValidationFailed` 的具体拼写）由 #12 原型票反应后定稿。
