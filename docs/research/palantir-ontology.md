# 调研：Palantir Ontology 语义深挖

- **票**：[#2 调研：Palantir Ontology 语义深挖](https://github.com/0xnicholas/heirloom-pro/issues/2)
- **父图**：[#1 Heirloom 图：企业领域模型系统的规格之路](https://github.com/0xnicholas/heirloom-pro/issues/1)
- **方法**：全部结论取自 Palantir 官方文档（palantir.com/docs）与 Palantir 第一方发布的 SDK 类型定义（npm 包 `@osdk/foundry.ontologies` 的 `.d.ts`），逐条内联溯源。社区帖子仅用于发现官方页面路径，不作为事实来源。
- **服务对象**：「本体语言核心语义 #5」「动作语义 #8」两张票。

---

## 1. 总体架构：四位一体与 Language / Engine / Toolchain

- Ontology 被定位为"Palantir 架构心脏处的系统"，代表企业的决策而非单纯数据，通过**数据、逻辑、动作、安全**四位一体的整合同时服务人类与 AI agent。[来源：Ontology system](https://www.palantir.com/docs/foundry/architecture-center/ontology-system/)
- 官方明确它**不是薄语义层**："cannot be accomplished with a thin semantic layer or a monolithic design"，而是由数十个组件组成的多模态系统，分为三层：**Language**（对象/链接/属性 + 动作 + 逻辑）、**Engine**（读架构：高规模 SQL 查询、实时订阅、物化；写架构：原子持久事务更新、批量 mutation、流、CDC）、**Toolchain**（OSDK 与 DevOps 治理）。[来源：Ontology system](https://www.palantir.com/docs/foundry/architecture-center/ontology-system/)
- 另一层经典定位：Ontology 是"组织的操作层（operational layer）"，坐在数据集/模型之上，作为组织的**数字孪生**，语义元素（objects/properties/links）+ 动能元素（actions/functions/dynamic security）。[来源：Object backend overview](https://palantir.com/docs/foundry/object-backend/overview/)

## 2. 对象 / 属性 / 链接的语言语义

### 2.1 Property 的元数据模型

一个 property 由以下元数据刻画 [来源：Property metadata reference](https://palantir.com/docs/foundry/object-link-types/property-metadata/)：

| 元数据 | 含义 |
|---|---|
| **ID** | 唯一标识，用于应用配置引用（如 `start-date`） |
| **Display name** | 人类可读名（如 `Start date`） |
| **API name** | 代码中编程引用名（如 `startDate`） |
| **Description** | 说明文本 |
| **Base type** | 值类型，决定可用操作 |
| **Status** | `experimental`（默认）/ `active` / `deprecated` 生命周期 |
| **Visibility** | `prominent` / `normal` / `hidden` |
| **Render hints** | 给渲染层的提示（如关闭 searchable/sortable 可提升 reindex 性能） |

- 三名分离（ID / display / API name）+ status 生命周期是可直接借鉴的元数据骨架。
- **受限类型**：`byte`、`float`、`short` 不能用于 action types；`decimal` 因 JSON/Java 精度转换不能用于 action types 且 OSv2 不支持；`vector` 只能 KNN 查询、最大 2048 维。[来源：Property metadata reference](https://palantir.com/docs/foundry/object-link-types/property-metadata/)

### 2.2 主键与对象身份

- "The object ID of an object type cannot be edited after the initial object type creation process."（对象 ID 创建后不可改）；改主键属于需要 unregister/reregister 的破坏性变更。[来源：Edit object types](https://palantir.com/docs/foundry/object-link-types/edit-object-type/)
- Create object 规则中主键是必填属性。[来源：Action rules](https://palantir.com/docs/foundry/action-types/rules/)
- 函数编辑 API 同样强制："the primary key property value of an existing object cannot be updated"。[来源：Functions TS v2 Ontology edits](https://palantir.com/docs/foundry/functions/typescript-v2-ontology-edits/)

### 2.3 链接语义

- 链接分**外键链接**（one-to-one / one-to-many，改的是对象上的外键属性）与**多对多链接**（有独立 link 实体，可增删）。"In order to create a one-to-many or one-to-one link type, simply edit the foreign key on the object."；对 M2M 链接才存在独立的 create/delete link 操作。[来源：Action rules](https://palantir.com/docs/foundry/action-types/rules/)
- 接口可以映射多对象类型的共享属性；action 规则有针对接口的变体；订阅接口对象集时服务端返回底层对象类型，客户端要自行重映射。[来源：Action rules](https://palantir.com/docs/foundry/action-types/rules/)、[WebSocket subscriptions](https://palantir.com/docs/foundry/ontology-sdk/websocket-subscriptions/)

## 3. Actions 语义（动词层）

### 3.1 核心定义

- "An **action type** is the definition of a set of changes or edits to objects, property values, and links that a user can take at once. It also includes the side effect behaviors that occur with action submission."（action type = 一次可执行的变更集合的定义 + 副作用行为）[来源：Action types overview](https://palantir.com/docs/foundry/action-types/overview/)
- "An action is a **single transaction** that changes the properties of one or more objects, based on a user-defined logic."（action 应用 = 单事务，多对象）[来源：Action types overview](https://palantir.com/docs/foundry/action-types/overview/)、[Object edits overview](https://palantir.com/docs/foundry/object-edits/overview/)
- 提交后变更"committed to the Ontology … reflected in all user applications"；最新状态（含用户编辑）落在 object type 的 **writeback dataset** / 物化数据集中。[来源：Action types overview](https://palantir.com/docs/foundry/action-types/overview/)

### 3.2 参数

- "Parameters are the inputs of an action type. They are the interface between the Rules and other Foundry applications."每个参数有类型；可逐个配置是否暴露在表单、是否允许用户修改（存在 hidden parameter，如 `Previous Status`）。[来源：Parameters overview](https://palantir.com/docs/foundry/action-types/parameter-overview/)]
- 参数可在规则、submission criteria、overrides（联动后续参数配置）中流转；对象引用参数携带完整对象。[来源：Parameters overview](https://palantir.com/docs/foundry/action-types/parameter-overview/)]

### 3.3 Submission criteria（原 validations）

- "Submission criteria (formerly known as validations) are the conditions that determine whether an action can be submitted."——把业务逻辑编码进编辑治理。[来源：Submission criteria](https://palantir.com/docs/foundry/action-types/submission-criteria/)]
- 三类条件模板：**Current user**（用户 ID / 组 / multipass 属性）、**Parameter**（不支持 attachment 与 object set 参数）、**Execution context**（Ontology Scenario 场景上下文）。条件 + 运算符（is / includes / each is…）+ 嵌套逻辑（all/any/no）。[来源：Submission criteria](https://palantir.com/docs/foundry/action-types/submission-criteria/)]
- 每个**根级**条件/逻辑运算符有独立失败消息，UI 全域（Object Explorer / Workshop / Quiver）展示。[来源：Submission criteria](https://palantir.com/docs/foundry/action-types/submission-criteria/)]
- 与编辑 action type 本身的权限**相互独立**；提交者必须能查看被编辑的 object/link type 及其 datasource。[来源：Action permissions](https://palantir.com/docs/foundry/action-types/permissions/)]

### 3.4 Rules / Edits 分类学（对 #8 最关键）

Rules "transform the parameters into Ontology edits or other effects"，分编辑型与效果型 [来源：Action rules](https://palantir.com/docs/foundry/action-types/rules/)]：

**编辑型规则**（原文逐条）：
1. **Create object** — 主键必填，其余可选。
2. **Modify object(s)** — 通过对象引用参数定位；**不能引用本次 action 内新建的对象**。
3. **Create or modify object(s)** — upsert：存在则改，不存在则建（自动生成 ID 或用户提交主键）。
4. **Delete object(s)** — 同样不能引用本次新建对象。
5. **Create link(s)** — 仅 M2M；外键链接必须用 Modify object 改外键属性。
6. **Delete link** — 仅 M2M。
7. **Function rule** — 引用 Ontology edit function，输入来自参数；**存在时不得再配其他规则**（函数能做其他规则的一切）。
- 另有针对 interface 的 5 个变体。

**规则编译与顺序**："the actions backend compiles rules to generate a single edit per object"；后写胜出；顺序影响结果；不支持：先删后增、先改后增（同对象）、一事务内两次创建同一对象。[来源：Action rules](https://palantir.com/docs/foundry/action-types/rules/)]

**值的来源（映射右侧）**：`From parameter` / `Object parameter property` / `Static value` / `Current User / Time`（上下文值，不可被用户交互修改）。[来源：Action rules](https://palantir.com/docs/foundry/action-types/rules/)]

**效果型规则**：Notification（编辑全部应用后发送，但内容基于编辑前状态）、Webhook（可配置在编辑前后执行）、Schedule（触发定时构建）。[来源：Action rules](https://palantir.com/docs/foundry/action-types/rules/)]

### 3.5 Apply Action API（协议层语义）

- `POST /api/v2/ontologies/{ontology}/actions/{action}/apply`，body 为 `{"parameters": {<ParameterId>: <DataValue>}}`。[来源：Apply Action API](https://palantir.com/docs/foundry/api/ontologies-v2-resources/actions/apply-action/)]
- **200 ≠ 成功**："a 200 HTTP status code only indicates that the request was received and processed by the server. See the validation result in the response body."响应含 `operationId`、`validation.result`（`VALID`/`INVALID`）、逐参数 `evaluatedConstraints`。[来源：Apply Action API](https://palantir.com/docs/foundry/api/ontologies-v2-resources/actions/apply-action/)]
- **写可见性契约**："Changes to objects or links stored in Object Storage v1 are eventually consistent…; Edits to objects or links in Object Storage v2 will be visible **immediately** after the action completes."[来源：Apply Action API](https://palantir.com/docs/foundry/api/ontologies-v2-resources/actions/apply-action/)]
- 实验性能力：`transactionId`（Ontology transaction）、`branch`、`scenarioRid`（Scenario 上的 what-if 模拟）。[来源：Apply Action API](https://palantir.com/docs/foundry/api/ontologies-v2-resources/actions/apply-action/)]
- 参数默认值在该端点暂不支持。[来源：Apply Action API](https://palantir.com/docs/foundry/api/ontologies-v2-resources/actions/apply-action/)]
- OSDK 类型定义证实同样的语义文档（响应即 `SyncApplyActionResponseV2`；另有异步 apply 形态 `operationId` 轮询）。[来源：`@osdk/foundry.ontologies@2.71.0` Action.d.ts](https://cdn.jsdelivr.net/npm/@osdk/foundry.ontologies@2.71.0/build/esm/public/Action.d.ts)]

### 3.6 写回与物化（数据落盘模型）

- **OSv1 (Phonograph)**：编辑历史存在对象存储里；"Every time a writeback dataset is built, the history of edits is reapplied"——回写数据集是**重放编辑历史**得到的快照；unregister 会删历史且令后续构建失败。[来源：Edit object types](https://palantir.com/docs/foundry/object-link-types/edit-object-type/)]
- **OSv2**：编辑开关（Edits toggle）+ **materializations**：自动模式（分钟级延迟传播用户编辑）或周期模式（输入有新数据或每 6 小时）；仅保最新快照、历史事务持续删除；schema 用 Ontology 定义的 API Name 而非 datasource schema；`__` 前缀列为内部去重元数据，不许生产依赖。[来源：Materializations](https://palantir.com/docs/foundry/object-edits/materializations/)]
- 用途定位：下游管道需要"含用户编辑的最新状态"、全量下载导出。[来源：Materializations](https://palantir.com/docs/foundry/object-edits/materializations/)]

### 3.7 函数式编辑（逻辑支柱的写路径）

- "For the edits created in a function to actually be applied, Ontology edit functions **must be configured as a function-backed Action**… running an edit function outside of an Action will not actually modify any object data."——函数写本体必须包装成 action（统一权限/审计/操作界面入口）。[来源：Functions TS v2 Ontology edits](https://palantir.com/docs/foundry/functions/typescript-v2-ontology-edits/)]
- 声明式编辑类型：`type OntologyEdit = Edits.Object<Employee> | Edits.Link<Employee, "assignedTickets"> | …`；`createEditBatch<OntologyEdit>(client)` 构造批次；`batch.create / update / delete / link / unlink`；返回 `batch.getEdits()`。[来源：Functions TS v2 Ontology edits](https://palantir.com/docs/foundry/functions/typescript-v2-ontology-edits/)]
- **无 read-your-writes**：同一次函数执行内，后续读取看不到自己刚 `update` 的值。[来源：Functions TS v2 Ontology edits](https://palantir.com/docs/foundry/functions/typescript-v2-ontology-edits/)]
- 1:1/1:N 链接通过改外键属性实现（`assignedEmployeeId: 52`，置 `undefined` 解除）——与 UI 规则层语义一致。[来源：Functions TS v2 Ontology edits](https://palantir.com/docs/foundry/functions/typescript-v2-ontology-edits/)]

## 4. 读写引擎行为

### 4.1 后端组件与两代对象存储

- 微服务架构：**OMS**（本体元数据：哪些实体存在）、**Object databases**（索引对象数据、查询、用户编辑编排）、**OSS**（读服务：search/filter/aggregate/load）、**Actions 服务**（应用用户编辑、复杂权限条件、historical action log）、**Funnel**（OSv2 写编排：从 datasource 与 Actions 读数据写入对象库）。[来源：Object backend overview](https://palantir.com/docs/foundry/object-backend/overview/)]
- **OSv1 (Phonograph) 将于 2026-06-30 后不可用**；OSv2 是下一代规范存储，"separates the subsystems responsible for indexing and querying data"以水平扩展。[来源：Object backend overview](https://palantir.com/docs/foundry/object-backend/overview/)]
- OSv2 硬指标：单 action 最多 **10,000 个对象**编辑；单对象类型最多 **2,000 个属性**；增量索引；流式 datasource 低延迟；多 datasource 对象类型带来**列级权限**；Search Around 默认 10 万对象；Spark 查询执行层。[来源：Object backend overview](https://palantir.com/docs/foundry/object-backend/overview/)]

### 4.2 查询与函数

- Queries 是"read-only subsets of functions"经 API gateway 暴露：`POST /api/v2/ontologies/{ontology}/queries/{queryApiName}/execute`，默认执行最新发布版本，无副作用（有副作用必须用 Action）。[来源：Query functions](https://palantir.com/docs/foundry/functions/query-functions/)、[Execute Query API](https://palantir.com/docs/foundry/api/ontologies-v2-resources/queries/execute-query/)]
- Functions 注册表要求显式类型注解，类型系统与对象属性类型对齐。[来源：Functions types reference](https://palantir.com/docs/foundry/functions/types-reference/)]

### 4.3 订阅（实时读）

- WebSocket 端点 `/api/v2/ontologySubscriptions/ontologies/{ontology}/streamSubscriptions`，认证用子协议 `"Bearer-{token}"`（注意是 `-` 不是空格）。JSON 消息：客户端发 `requests[]`（`objectSet` 必填，`propertySet`/`referenceSet` 可选），服务端回 `subscribeResponses`（成功给 subscription ID；`qos` 类型表示过载，需指数退避+抖动重试）、`objectSetChanged`（`state`: `ADDED_OR_UPDATED` / `REMOVED`，REMOVED 表示删除或不再匹配过滤器）、`refreshObjectSet`（无法增量时降级为全量重载）、`subscriptionClosed`。[来源：WebSocket subscriptions](https://palantir.com/docs/foundry/ontology-sdk/websocket-subscriptions/)]
- 限制：join 构造的对象集不保证完整性；订阅不跨服务端重启持久（客户端自实现重连）；每订阅内存上限；部分全文检索过滤不支持。[来源：WebSocket subscriptions](https://palantir.com/docs/foundry/ontology-sdk/websocket-subscriptions/)]
- TS OSDK 侧 `.subscribe`（`@osdk/client` ≥2.1）封装该协议。[来源：TypeScript subscriptions](https://palantir.com/docs/foundry/ontology-sdk/typescript-subscriptions/)]

## 5. OSDK / 工具链

- OSDK 从 Ontology 生成"just the subset of the Ontology relevant to you"，分发：NPM(TS) / Pip(Java 前 Python) / Maven / **OpenAPI spec（任意语言）**。[来源：OSDK overview](https://palantir.com/docs/foundry/ontology-sdk/overview/)]
- 安全模型："uses a token that is scoped only to the ontological entities you want your application to access, in addition to the user's own permissions to the data."——**token 范围 ∩ 用户权限**的双重叠加。[来源：OSDK overview](https://palantir.com/docs/foundry/ontology-sdk/overview/)]
- OSDK 2.0：`createClient` 需显式 `ontologyRid`；client 直接可调用（`client($omd.Restaurant)` 风格）。[来源：TS OSDK migration guide](https://palantir.com/docs/foundry/ontology-sdk/typescript-osdk-migration/)]
- **Ontology-as-code / SuperRepo**（Beta）：对象类型、链接、action 与函数、前端在同一个 pro-code monorepo 里声明；OSDK 本地生成、定义变更即再生成，形成单一 edit-and-preview 循环，无需发布 SDK 版本。[来源：OSDK overview](https://palantir.com/docs/foundry/ontology-sdk/overview/)、[SuperRepo core concepts](https://www.palantir.com/docs/foundry/superrepo/core-concepts)]
- SDK 文档页即按示例对象（`Restaurant` + 其 actions/queries）生成——"Developer Console generates documentation based on your specific Ontology"。[来源：TypeScript OSDK](https://palantir.com/docs/foundry/ontology-sdk/typescript-osdk/)]

---

## A. Heirloom 规格可直接借鉴的机制清单

1. **Action = 显式声明的动词类型**，而非裸 CRUD 透出：参数 + 校验 + 编辑集 + 副作用打包成一个可复用、可治理单元（§3.1）。
2. **编辑规则分类学**：create / modify / create-or-modify(upsert) / delete object + link/unlink(仅 M2M) + 外键改属性(1:1/1:N) + function rule（独占配额）。Heirloom v1 动作语义票可直接以此为骨架裁剪（§3.4）。
3. **规则编译为"每对象单一 edit"**：多规则合并、后写胜出、顺序敏感、禁止 delete-before-add / double-create。Heirloom 即便 v1 只有 function-backed action，也应保留"编辑集在事务内编译/折叠"的语义（§3.4）。
4. **不能引用本事务新建对象**（modify/delete 侧）与 **upsert 例外**——精确的事务内引用规则，Heirloom 必须显式定义（§3.4）。
5. **参数模型**：类型化参数 + hidden/只读参数 + 上下文值（current user / submission time）作为映射来源（§3.2、§3.4）。
6. **Submission criteria 与权限解耦**：三类条件模板（user / parameter / context）+ 根级失败消息 + 逐参数校验结果。Heirloom 最小版可只做 parameter + user 两类（§3.3）。
7. **HTTP 层与业务校验分离**："200 ≠ 成功"，响应体 `validation.result: VALID/INVALID` + 逐参数 `evaluatedConstraints`。Heirloom 的 REST 设计应直接采用此契约（§3.5）。
8. **写可见性契约显式化**：Foundry 区分 OSv1 最终一致 / OSv2 立即可见；Heirloom 单 Postgres 应承诺**动作提交即同步可见**并写进规格（§3.5）。
9. **函数写路径必须包装为 function-backed action** 才能落盘——逻辑支柱与动作支柱统一入口，权限与审计只挂在 action 上。Heirloom"逻辑留接口位"应采纳同一纪律（§3.7）。
10. **声明式编辑批次 API**：`Edits.Object<X> | Edits.Link<X, …>` 类型联合 + `createEditBatch` + `create/update/delete/link/unlink`——TS DSL 原型（#12）的直接参考（§3.7）。
11. **编辑历史与物化快照分离**：writeback/物化是"输入数据源 + 用户编辑"合并出的可重建快照，API Name 驱动 schema。Heirloom 可把"对象表"本身当权威态、物化留 v2，但语义分层值得保留（§3.6）。
12. **订阅协议骨架**：objectSet/propertySet 订阅请求、`ADDED_OR_UPDATED/REMOVED` 事件、`refreshObjectSet` 降级语义、过载 qos 信号。Heirloom 若做订阅（#7 票）照此形状设计 WebSocket 协议（§4.3）。
13. **Property 三名分离 + status 生命周期**（id/displayName/apiName + experimental/active/deprecated）——本体语言票（#5）的元数据骨架（§2.1）。
14. **主键不可变**（创建后不可改）+ 受限类型清单——Heirloom 类型系统边界直接借鉴（§2.1、§2.2）。
15. **OSDK 的双重授权模型**：token 限定本体实体子集 ∩ 用户自身权限。Heirloom v1 的 scoped token 设计可从这起步（§5）。
16. **生成式 SDK 文档**：按用户自己的本体生成 API 文档——Heirloom 的 OpenAPI/SDK 天然可做（§5）。

## B. 文档未覆盖、Heirloom 必须自行设计的空白清单

1. **本体定义的 code-first 文件格式**：Palantir 以 UI/元数据服务为主，ontology-as-code 仍是 Beta 且绑定 SuperRepo 闭源工具链；TS DSL 作为第一公民的文件格式、codegen 循环、版本发布必须自行设计（喂 #6、#12）。
2. **存储 schema 映射**：文档只讲服务架构（Funnel/object databases），不公开内部存储模型。一类型一表 vs JSONB vs 混合（#7 票）完全自主。
3. **并发控制与隔离级别**：多对象单事务的乐观并发（version/etag 列？冲突时行为）、action 幂等性（`operationId` 存在但幂等键语义未公开）未见于文档——Heirloom 必须定义（喂 #8）。
4. **订阅的可靠投递**：Foundry 明确"订阅不跨重启持久、无重放令牌，降级为全量刷新"；Heirloom 在 Postgres 上可用 LSN/watermark 做更强的重放语义，需自行设计（喂 #7）。
5. **审计日志的 schema**：仅一句 "historical action log"；记录什么字段、保留多久、如何查询都未公开（喂 #8）。
6. **对外部源系统的真正写回**：Foundry 的"writeback"实为写回 Foundry 内部数据集；对第三方系统的同步触发仅有 Webhook 副作用规则。Heirloom 的"写回"边界要自行定义（喂 #8、#11）。
7. **权限内部机制**：marking/ACL 如何在查询时下推到对象库未公开；行级/列级在 Postgres 上如何实现（RLS？查询改写？）是 #9 票的核心空白。
8. **完整值类型清单**：文档散落多页且部分类型受限（decimal/byte/vector），没有单一权威枚举——Heirloom 需定义自己的标量与结构类型集（喂 #5）。
9. **链接基数/链接属性的存储语义**：文档只在 UI 配置层描述（cardinality 选项存在），链接属性是否有、怎么存未公开（喂 #5）。
10. **Scenario/branch（what-if 模拟）**：Foundry 标注为实验性；Heirloom v1 明确不做即可，但规格应显式写为 out of scope 以防范围蔓延（喂规格大纲票）。

---

## 补充精读：Ontology system 页（2026-08-16，#8 会话重定向）

- **写回是动作支柱的本义**："The Ontology is designed to model the full range of **actions**, from simple transactions to complex multi-step updates that must be written back to operational and edge systems in real time."——写回不是数据同步附属品，而是动作概念的核心定位；Heirloom v1 的切割线归 [#8](https://github.com/0xnicholas/heirloom-pro/issues/8)。
- **逻辑以函数形态被动作编排**："the underlying optimizers, or abilities to call LLMs, which manifest into functions which are interactively orchestrated via actions, might have altogether different security scopes"；"Every piece of logic … can be connected to every action, within a decision graph"。——动作↔函数接缝 + 安全作用域叠加是 #8/#10/#9 的跨票决策。
- **安全在交互时全支柱调和**："The Ontology's security system has to reconcile all of these granular policies, at the time of interaction, across tens of thousands of humans and agents"；agent 作用域「继承自人类用户或项目权限结构」。——喂 [#9](https://github.com/0xnicholas/heirloom-pro/issues/9)。
- **引擎写架构四件套**：原子持久事务更新、批量 mutation、流、CDC 低延迟镜像——后两者已在图外（v1 单 Postgres）。
