# 附录

> **范围**：错误码注册表（单一权威）、数值限制清单、已知限制与 v2 去向汇总（各章末「已知限制」在此归总）、语言选型重访条件、冻结反应物索引。
> **不含**：正文语义。
> **素材**：各章散点（本附录为收口，不引入新决议；个别通用码的补全见行内注记）。
> **待落位**：无。
> **验收线**：深规格（[#13](https://github.com/0xnicholas/heirloom-pro/issues/13) 决议：总表归附录、附录为单一权威）

## 1. 错误码注册表（单一权威）

规范性陈述：

- 本表是错误码的**唯一权威**：正文各章只引用不增改；新增/修改错误码**必须**先改本表。
- 全部错误共用信封 `{error: {code, message, details?}}`（[30](30-api.md) §6）；`message` 人类可读、`details` 形状随 code 固定。
- **零行 = 200 空集，永不 403**（静默收窄）——本注册表不含「零授权」码。

| code | HTTP | 场景 | `details` 形状 | 首见 |
|---|---|---|---|---|
| `BAD_REQUEST` | 400 | 请求体畸形（非法 JSON、未知结构）；push 定义结构校验先行拒绝 | 违规位置 + 描述 | [30](30-api.md) §2 / §4.1 |
| `UNAUTHENTICATED` | 401 | 无效/缺失 PAT；**落安全日志** | 主体（可知时）、原因 | [30](30-api.md) §2 / [50](50-security.md) §10 |
| `ADMIN_FORBIDDEN` | 403 | 非超管调用仅超管 admin 端点；**落安全日志** | 端点、主体 | [30](30-api.md) §4 |
| `WHITELIST_DENIED` | 403 | 引擎层动作白名单拒；**落安全日志** | 动作 apiName、原因 | [20](20-actions.md) §7 / [50](50-security.md) §8 |
| `PERMISSION_DENIED` | 403 | `execute` 内 PermissionDenied；**落安全日志** | 动作 apiName、原因 | [20](20-actions.md) §7 |
| `NOT_FOUND` | 404 | 类型/动作/函数 apiName 不存在；GET 对象 miss（零授权不可见同形） | 场景标识 | [30](30-api.md) §3 |
| `PRECONDITION_FAILED` | 409 | 乐观锁：`If-Match` / `expectedUpdatedAt` 命中旧值，整事务回滚 | 期望/实际 `updated_at` | [40](40-engine.md) §8 / [20](20-actions.md) §8 |
| `UNIQUE_CONFLICT` | 409 | `unique` 业务键冲突（含接入批量）；约束标识必带 | 约束标识（`type.property`）；接入场景另附违规条目清单（逐条 index/op/constraint） | [10](10-language.md) §3.2 / [30](30-api.md) §4.2 |
| `LINK_RESTRICTED` | 409 | 删除被 required 链接引用阻止 | 引用方清单（type + id + linkName） | [40](40-engine.md) §4 |
| `BATCH_TOO_LARGE` | 413 | 接入批量 >1000 对象/请求 | 实际数 / 上限 | [70](70-operations.md) §2 |
| `VALIDATION_FAILED` | 422 | 动作校验失败（逐字段）；ref 参数对象不存在（注入 miss）；查询体越限（sort/limit/include）；接入约束违例（NOT NULL/CHECK/FK） | 动作：`{field: message}` 逐字段；接入：违规条目清单；查询：越限字段与限值 | [20](20-actions.md) §4 / [30](30-api.md) §3–4 |
| `PUSH_REJECTED_DATA_VALIDATION` | 422 | push 数据校验档存量不过，**整事务拒绝** | 逐变更明细（kind/target/violation） | [60](60-evolution.md) §4.2 |
| `PUSH_REJECTED_BREAKING` | 422 | push 拒绝档；联动校验悬空引用（[60](60-evolution.md) §7）；**出路建议必带** | 逐变更明细（kind/target/**remedy**——三通道指路；悬空引用场景 remedy = 先解除引用） | [60](60-evolution.md) §4.3 / §5 |
| `INTERNAL` | 500 | 引擎内部错误（含动作事务超时——超时即回滚，[20](20-actions.md) §6） | 事务 id（可关联日志） | [30](30-api.md) §6 |

- 注记：状态码映射与专属码集承 ADR-0008；`BAD_REQUEST` / `UNAUTHENTICATED` / `ADMIN_FORBIDDEN` / `NOT_FOUND` / `LINK_RESTRICTED` / `INTERNAL` 为通用码/落码补全（收口按各章语义闭合，非新决议）；5xx 域**不属**稳定契约（客户端只应预期 `INTERNAL` 占位）。

## 2. 数值限制清单（单一权威）

| 限制 | 值 | 出处 |
|---|---|---|
| 接入/批量写入 | ≤1000 对象/请求 | [40](40-engine.md) §8 / [70](70-operations.md) §2 |
| 查询 `limit` | 默认 100、上限 1000 | [40](40-engine.md) §6 |
| 排序键 | ≤3 键（id 隐式末位锥） | [40](40-engine.md) §6 |
| `include` 链深 | ≤2 跳/条 | [40](40-engine.md) §6 |
| 过滤/排序域 | 当前类型属性 + 一跳链接属性 | [40](40-engine.md) §6 |
| struct 嵌套 | ≤2 层 | [10](10-language.md) §2 |
| `integer` 值域 | ±2^53（JSON 安全区间） | [10](10-language.md) §3 |
| 动作事务超时 | 存在上限（默认 30s、可配置；规格只锁「存在」） | [20](20-actions.md) §6 |
| 每表属性数/行宽 | 软上限**建议存在**（具体值随实现定） | [40](40-engine.md) §2 |
| PAT 明文 | 仅签发时返回一次 | [50](50-security.md) §4 |

## 3. 已知限制与 v2 去向（各章汇总）

| 领域 | 限制 | 章 | 去向 |
|---|---|---|---|
| 语言 | 无继承/接口/n 元关系/链接属性 | [10](10-language.md) | v2 |
| 语言 | 无 byte/short/vector/uuid 标量；无复合业务键 | [10](10-language.md) | v2 |
| 语言 | 反向遍历弱类型；自引用 thunk `(): any` | [10](10-language.md) | v2 |
| 语言 | `json` 标量内部零约束零索引（逃生舱明示） | [10](10-language.md) | 维持 |
| 动作 | 无幂等键（盲目重试可能双花；业务键兜底） | [20](20-actions.md) | v2 |
| 动作 | 审计入参不脱敏（token 永不出现在入参） | [20](20-actions.md) | v2 |
| 动作 | 无副作用/写回/多步编排/调用桥；无请求内多动作部分成功；无声明式 criteria | [20](20-actions.md) | v2 |
| API | 无速率限制 | [30](30-api.md) | v2 |
| API | 无逐本体 OpenAPI 生成；GraphQL 缺席 | [30](30-api.md) | v2 |
| 引擎 | 跨类型查询/全文检索/按链接属性排序缺席 | [40](40-engine.md) | v2 |
| 引擎 | 无推送（水位线+游标轮询）；删除不可轮询（无墓碑） | [40](40-engine.md) | v2 |
| 引擎 | 行宽软上限待实现定值 | [40](40-engine.md) | 实现 |
| 安全 | 仅静态 PAT（OIDC/密码 → v2）；授权无版本化；审计不脱敏（同上）；授权声明式导入（DSL sync）推迟 | [50](50-security.md) | v2 |
| 安全 | 一跳链接过滤的推断泄漏面（二分探测） | [50](50-security.md) | 维持（特性代价） |
| 演化 | 重命名不迁数据；可选→required 无 default 不可自动化 | [60](60-evolution.md) | 维持（三通道为官方出路） |
| 演化/部署 | 无降级路径（迁移只向前） | [70](70-operations.md) | 维持 |
| 部署 | 导入不记逐对象审计明细；单节点无 HA；同步器无托管运行时 | [70](70-operations.md) | v2 / 边界外 |

- **永久否决**（非推迟）：迁移脚本语言、`--allow-data-loss` 强制通道（[60](60-evolution.md) §5）；服务端 CSV 解析（[70](70-operations.md) §3）。

## 4. 语言选型重访条件（ADR-0006）

TypeScript 全栈 + 单 Postgres（[01](01-architecture.md)）维持至 v2。出现以下任一信号须**新开 ADR** 重开语言选型（届时更可能是「Postgres 旁加计算层」而非「引擎换语言」）：

1. 引擎内出现重计算需求（分析查询、大规模内存处理）；
2. 多租户 SaaS 规模（当前边界外）；
3. 动作体改用非 JS 语言定义；
4. 目标受众变为 Java 企业开发群体。

## 5. 冻结反应物索引（资料性）

| 分支 | 内容 | 规格锚点 |
|---|---|---|
| [`prototype/ts-dsl-shape`](https://github.com/0xnicholas/heirloom-pro/blob/prototype/ts-dsl-shape/prototype/ts-dsl-shape/ontology.ts) | DSL 原型 + 冻结示例本体（HR/项目域） | [10](10-language.md) §7、[80](80-scenarios.md) |
| `prototype/workbench-ui` | 工作台三变体 UI 原型 | workbench-spec（另册） |
| `research/*`（四分支） | Palantir 语义深挖 / 开源同类 / TS+Postgres 栈 / DSL 生成选型 | 各 ADR 输入 |

---
*决策史：#13（总表归附录）；各章「已知限制」节；ADR-0006（重访条件）。*
