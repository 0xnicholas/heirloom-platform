# API 面

> **范围**：REST 线上面总则、语义面端点逐个（query / 单对象 / 动作 / 函数 / meta）、查询体编码、管理面 `/v1/admin/*` 九组（push / ingest / 审计 / 安全日志 / 主体 / 组 / 读授权 / 动作授权 / token）、错误模型与状态码映射、OpenAPI 口径、CLI 映射。
> **不含**：查询包算子语义（[40](40-engine.md) §6）；动作/函数执行语义（[20](20-actions.md)）；演化收敛语义（[60](60-evolution.md)）；接入语义（[70](70-operations.md)）。
> **素材**：[ADR-0008](../adr/0008-api-and-logic-interfaces.md)（#10 决议全文）；编码义务移交清单 ADR-0002/0003/0004/0005/0007。
> **待落位**：无。
> **验收线**：深规格（[#13](https://github.com/0xnicholas/heirloom-pro/issues/13) 决议：逐端点表、逐条规范性陈述、示例内嵌、总表归附录）

## 1. 定位：REST 唯一线上面

- v1 线上面 = **REST 通用端点 + TS SDK**；GraphQL 显式推迟 v2（逐本体动态 SDL、resolver 语义、分页/授权渗透——规格面翻倍不值；根决策表述已修订为「TS DSL + REST（GraphQL → v2）」）。
- 端点集对**任意本体不变**：additive 演化不改 API 面（[60](60-evolution.md) §8）；SDK 从本体源码同源编译跟上演化，服务端不签发。
- **被否**：REST + GraphQL 双面齐上（两套一致语义双倍规格面）；GraphQL 优先（SDK/CLI/管理面仍绕不开 REST）。

## 2. 通用约定

| 维度 | 约定 |
|---|---|
| 认证 | 全部端点 `Authorization: Bearer <PAT>`（[50](50-security.md) §4）；无效/缺失 → 401 + 安全日志条目 |
| 成功信封 | 统一 `{data, nextCursor?}`（列表）/ `{data}`（单对象与调用结果） |
| 错误信封 | 统一 `{error: {code, message, details?}}`（§6） |
| 内容类型 | `application/json`（请求与响应） |
| 路径命名 | `{type}` = 对象类型 `apiName`（kebab-case）；`{apiName}` = 动作/函数名（kebab-case） |
| 标量编码 | 沿 [10](10-language.md) §3：`decimal` 全链路 JSON 字符串、`integer` ±2^53、`datetime` ISO 8601 带时区偏移 |

- 请求体畸形（非法 JSON、未知字段结构）**必须**以 400 拒绝，与 422（语义校验失败）严格分立。

## 3. 语义面端点（五件套）

### 3.1 `POST /v1/objects/{type}/query` —— 对象查询

请求体字段：

| 字段 | 类型 | 约束 |
|---|---|---|
| `filter` | 过滤表达式 | 算子封闭集见 [40](40-engine.md) §6；仅当前类型属性 + 一跳链接属性（点路径） |
| `sort` | `[{field, dir}]` | ≤3 键；超过 → 422；null 排序随 Postgres 默认（ASC NULLS LAST / DESC NULLS FIRST）并已文档化 |
| `cursor` | 不透明字符串 | keyset 游标（排序键 + id 锥）；客户端**不得**解析或自行构造 |
| `limit` | 整数 | 默认 100、上限 1000；超过上限 → 422 |
| `include` | 点路径数组 | 每条链最深 2 跳；更深 → 422；各跳按**各自**行级谓词过滤（[50](50-security.md) §7） |
| `count` | 布尔 | 省缺 false；true → 响应附 `count`（同过滤器聚合计数） |

过滤编码（normative，字段键 × 算子名）：

```jsonc
// and/or/not 任意嵌套；一跳链接属性用点路径；数组 contains-any；eq: null 即 null 检查
{ "filter": { "and": [
    { "status": { "eq": "active" } },
    { "mentor.name": { "startsWith": "N" } },          // 一跳链接属性过滤
    { "not": { "certifications": { "contains-any": ["go", "rust"] } } }
  ] },
  "sort": [{ "field": "employeeNo", "dir": "asc" }],   // id 隐式末位锥，稳定排序
  "include": ["mentor", "projects.employee"],           // ≤2 跳/条
  "count": true }
```

```jsonc
// 200 响应（零授权类型 = 空集，静默收窄——永不 403）
{ "data": [/* 对象数组；不可见链接侧剔除：多值变短、单值变 null */],
  "nextCursor": "b3BhcXVl…",   // 末页省缺
  "count": 42 }
```

- `{type}` 不存在 → 404；主体对该类型零授权 → 200 `{data: []}`（与空集不可区分——特性，[50](50-security.md) §5）。

### 3.2 `GET /v1/objects/{type}/{id}` —— 单对象取

- 可带 include：查询参数 `?include=mentor&include=projects.employee`（形状同 3.1）。
- 命中 → 200 `{data}`；id 不存在或不可见 → 404（零行/拒绝不可区分）。
- 可选 `If-Match: <updated_at>` 并发头：命中旧值 → 409 `PRECONDITION_FAILED`（[40](40-engine.md) §8 语义复用）。

### 3.3 `POST /v1/actions/{apiName}/invoke` —— 动作调用

- 请求体 = 参数对象（键 = 参数名；`ref` 参数传 UUID 字符串，[20](20-actions.md) §3）；引擎预取注入完整对象——id 不存在 → 422 `VALIDATION_FAILED`（参数校验范畴）。
- 响应 = 动作结果对象（`execute` 返回值原样）。
- 同步执行、单事务（[20](20-actions.md) §6）；事务超时 → 回滚（超时错误码注册表见 [90](90-appendix.md)）。
- 授权两层照常：白名单拒 → 403 `WHITELIST_DENIED`；`execute` 内 `PermissionDenied` → 403 `PERMISSION_DENIED`（均落安全日志，[50](50-security.md) §8）。
- `{apiName}` 不存在 → 404。
- 重试语义（normative，写入 API 文档）：盲目重试**可能双花**；带 `expectedUpdatedAt` 参数或 `unique` 业务键兜底（[20](20-actions.md) §8）。

### 3.4 `POST /v1/functions/{apiName}/invoke` —— 只读函数调用

- 与动作对称（动词后缀 `invoke` 不与元数据读混淆）；请求/响应同构（参数对象 → `{data}`）。
- `q` 只读上下文同步执行；读授权照常生效（每次读取经行级谓词编译，[20](20-actions.md) §11、[50](50-security.md) §7）——函数内零授权 = 空结果，200。
- `{apiName}` 不存在 → 404。

### 3.5 `GET /v1/meta/ontology` —— introspection

- 响应 `{revision, definition}`：当前生效定义（类型/属性/链接/动作/函数，含 `status` 字段——纯元数据，[60](60-evolution.md) §6）+ revision（[60](60-evolution.md) §2）。
- 认证主体即可读；CLI/SDK 的版本锚点（SDK 同源编译对账：期望态 ↔ 生效态 revision 比对）。

## 4. 管理面：`/v1/admin/*` 单伞

授权总则：**其余 admin 端点仅超管**（`isAdmin` 短路，[50](50-security.md) §3）；唯一例外 = `POST /ingest`（服务账号经超管授予接入授权后可调，[70](70-operations.md) §2）。非超管调用 → 403（码注册表见 [90](90-appendix.md)）。

| 端点 | 方法 | 语义 |
|---|---|---|
| `/v1/admin/ontology` | `PUT` | push：全量期望态定义 JSON（[60](60-evolution.md) §2） |
| `/v1/admin/ingest` | `POST` | 批量接入 ≤1000（§4.2） |
| `/v1/admin/audit` | `GET` | 审计日志查询：keyset 过滤只读（动作条目 + 导入批次条目） |
| `/v1/admin/security-log` | `GET` | 安全日志查询：keyset 过滤只读 |
| `/v1/admin/subjects` | CRUD | 主体（用户/服务账号）管理 |
| `/v1/admin/groups` | CRUD | 组管理（扁平不嵌套） |
| `/v1/admin/read-grants` | CRUD | 读授权（类型级 + 行级谓词表达式） |
| `/v1/admin/action-grants` | CRUD | 动作白名单授权 |
| `/v1/admin/tokens` | `POST` / `GET` / `DELETE /{id}` | PAT 签发 / 列表 / 吊销 |

- 接入独立非 admin 路径**被否**（授权模型割裂）；授权并单端点**被否**（读写面混淆）。

### 4.1 `PUT /v1/admin/ontology`（push 编码，承 ADR-0007）

```jsonc
// 200 成功收敛
{ "revision": 7, "changes": { "auto": 5, "dataValidation": 1 } }
// 200 no-op（期望态 == 当前生效定义；不涨 revision、不落 push 审计行）
{ "revision": 7, "noop": true }
// 422 拒绝（整事务拒；details 逐变更明细 + 出路建议——三通道见 60 §5）
{ "error": { "code": "PUSH_REJECTED_BREAKING",
  "details": { "changes": [ { "kind": "rename-apiName", "target": "employee.salary",
    "remedy": "加新属性(自动) → 一次性动作搬值 → 删旧属性，分多次 push" } ] } } }
```

- 三档拒绝码：拒绝档 → `PUSH_REJECTED_BREAKING`；数据校验档存量不过 → `PUSH_REJECTED_DATA_VALIDATION`（均 422 + 逐变更明细，[60](60-evolution.md) §4）；联动校验悬空引用（谓词/动作/queryFn → 被删对象）→ 422，码同拒绝档（[60](60-evolution.md) §7）。
- 定义结构校验（命名/反向名派生冲突）在分类前先行拒绝（400 域，[60](60-evolution.md) §7）。

### 4.2 `POST /v1/admin/ingest`（接入端点编码，承 ADR-0005）

```jsonc
// 请求：单请求单事务；>1000 → 413 BATCH_TOO_LARGE
{ "source": "hr-sync",
  "operations": [
    { "type": "employee", "op": "create", "object": { "employeeNo": "E001", /* … */ } },
    { "type": "employee", "op": "modify", "id": "018f…", "patch": { "status": "on-leave" } },
    { "type": "membership", "op": "delete", "id": "018f…" } ] }
// 200：回执 requestId 与导入批次审计条目一致（计数逐类型，[70](70-operations.md) §4）
{ "requestId": "req_01H…", "counts": { "employee": { "create": 1, "modify": 1 }, "membership": { "delete": 1 } } }
// 失败：整批回滚 + 违规条目清单（unique 冲突 → 409 UNIQUE_CONFLICT 带约束标识；
// NOT NULL / CHECK / FK 违例 → 422 VALIDATION_FAILED；required 链接阻删 → 409 LINK_RESTRICTED 带引用方清单，[40](40-engine.md) §4）
{ "error": { "code": "UNIQUE_CONFLICT", "details": { "violations": [
    { "index": 0, "type": "employee", "op": "create", "constraint": "employee.employeeNo", "message": "duplicate" } ] } } }
```

- **不得**触发动作语义；每请求**必须**落恰好一条导入批次审计条目（含整批回滚——计数为 0，[70](70-operations.md) §4）。

### 4.3 token 三端点

- `POST /v1/admin/tokens`：为主体签发 PAT；明文 token **仅此一次**返回，此后任何端点**不得**再出现明文。
- `GET /v1/admin/tokens`：列表（id、主体、签发时间；无明文）。
- `DELETE /v1/admin/tokens/{id}`：吊销，即时生效。

## 5. OpenAPI 口径

- 实现**必须**导出 OpenAPI 3 文档 = **静态固定面**：端点集不随本体变（§1）。
- 逐本体 OpenAPI/SDL 生成 → v2（[90](90-appendix.md)）。**被否**：逐本体 OpenAPI（与静态面矛盾）。

## 6. 错误模型（映射表；注册表单一权威归 [90](90-appendix.md)）

信封：`{error: {code, message, details?}}`。映射：

| 状态 | code | 场景 |
|---|---|---|
| 400 | `BAD_REQUEST` | 请求体畸形（与 422 严格分立） |
| 401 | `UNAUTHENTICATED` | 无效/缺失 token；落安全日志（[50](50-security.md) §10） |
| 403 | `WHITELIST_DENIED` / `PERMISSION_DENIED` | 引擎层白名单拒 / 代码层 PermissionDenied；均落安全日志 |
| 404 | `NOT_FOUND` | 类型/动作/函数名不存在；GET 对象 miss（零授权不可见同形） |
| 409 | `PRECONDITION_FAILED` / `UNIQUE_CONFLICT` / `LINK_RESTRICTED` | 乐观锁（If-Match / expectedUpdatedAt）/ unique 冲突（带约束标识）/ required 链接阻删（带引用方清单） |
| 413 | `BATCH_TOO_LARGE` | 接入批量 >1000 |
| 422 | `VALIDATION_FAILED` | 动作校验失败（逐字段）；ref 参数对象不存在；查询体越限（sort/limit/include）；接入非 unique 约束违例 |
| 422 | `PUSH_REJECTED_DATA_VALIDATION` / `PUSH_REJECTED_BREAKING` | push 三档拒绝（逐变更明细 + 出路建议，§4.1） |
| 500 | `INTERNAL` | 引擎内部错误（含动作事务超时） |

- **零行 = 200 空集，永不 403**（静默收窄，[50](50-security.md) §5）。**被否**：零行 403（破坏静默收窄）；ValidationFailed 走 400（与畸形请求混淆）。
- `details` 形状随 code 固定（如 `VALIDATION_FAILED` 逐字段、push 拒绝逐变更、接入违规逐条目）；全量注册见 [90](90-appendix.md)。

## 7. CLI 映射（1:1）

| CLI | 端点 |
|---|---|
| `heirloom ontology apply` | `PUT /v1/admin/ontology` |
| `heirloom import` | `POST /v1/admin/ingest` |
| `heirloom migrate-only` | 引擎迁移入口（非 HTTP；[70](70-operations.md) §7） |
| `heirloom admin <subjects|groups|read-grants|action-grants|tokens>` | 对应 `/v1/admin/*` CRUD |

- CLI **必须**与端点 1:1 映射——CLI 是端点的薄壳，不引入独立语义。

## 8. 已知限制与 v2（详见 [90](90-appendix.md)）

无速率限制；无逐本体 OpenAPI 生成；GraphQL 缺席 v1。

---
*决策史：ADR-0008（四决策）、ADR-0002（查询包/If-Match/批量）、ADR-0003（invoke/ValidationFailed/queryFn）、ADR-0004（403 双 code/管理面/零行=200）、ADR-0005（接入/导入批次）、ADR-0007（push 编码/三档拒绝）。*
