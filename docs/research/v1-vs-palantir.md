# v1 vs Palantir Foundry Ontology：差距盘点（v2 路线输入）

> **范围**：Heirloom v1.0.0 实况 vs Palantir Foundry Ontology——四支柱语义 + 引擎 + 工具链（OSDK）+ 部署形态的逐条差距；定位主张；v0 遗物（Abilities / 链接三原语 / Agent 一等公民）处置评估；v2 候选优先级。
> **不含**：AIP / Workshop / Quiver / Pipeline Builder 等 Ontology **之上**的应用产品层——那些是产品不是平台，仅在 §6.5 带一句边界说明。
> **事实来源**：[palantir-ontology.md](./palantir-ontology.md)（2026-08-16，逐条溯源 Palantir 官方文档与 OSDK 类型定义）+ 本仓库 v1 规格与实现。
> **状态**：v2 规划输入；冲突时以 [spec](../spec/) 为准。

## 1. 一句话现状

v1 是 Palantir Ontology 四支柱的**最小语义同构**——核心语言/动作/安全语义对齐，偏离主要是刻意的（砍小、自部署、code-first）；差距集中在**规模引擎、实时读、写回、生态**，而这四样里三样是 v1 明确推迟的，只有生态是无规划空白。

## 2. 定位主张：Heirloom v1 凭什么存在

不是「开源版 Palantir」，而是**另一个重量级**：

1. **Code-first 本体**——本体 = TypeScript 模块，进 git、可 code review、有类型检查、随代码 CI 演化。Palantir 的 ontology-as-code（SuperRepo）仍是 Beta 且绑定闭源工具链。
2. **Spec-first 建造**——12 章规格 + 9 篇 ADR 先于代码存在，验收场景（S0–S12）锚定每条决议；「规格是权威，实现是建造」。这是可审性，不是功能。
3. **单进程 TS + 单 Postgres，自部署**——`docker compose up` 即得全栈。Palantir 是多模态微服务集群（OMS/Object DBs/OSS/Actions/Funnel）+ 托管 SaaS；OSv1 Phonograph 2026-06 已 EOL。
4. **最小可审面**——约 11.5k 行 TS、6 个包、零黑盒依赖；语义取舍全部写进规格和 ADR。Palantir 的价值恰恰在它替你运营的复杂度——那是另一种产品形态，不是本项目的。
5. **语义反向优势（小而真）**——单事务活模型：**读己之写**（Palantir 函数式编辑明确无 RYW）、**同事务引用新建对象**（Palantir modify/delete 规则不能引用本事务新建对象）、**提交即同步可见**（Palantir OSv1 最终一致）。这三条对「动作体内业务逻辑」是实打实的语义简化。

**主张的诚实边界**：以上换来的是规模天花板（单 PG）、无实时订阅、无写回编排、无企业生态（SSO/标记/审批流）。定位 = **Palantir 语义骨架的开源自部署最小实现，换掉的是规模与生态，不是语义**。

## 3. 差距清单（按支柱）

标注：`对齐` 语义同构 ｜ `砍→v2` 规格明确推迟 ｜ `空白` 无规划 ｜ `反向` v1 更强

### 3.1 语言（对象/属性/链接/struct）

| 项 | Palantir | Heirloom v1 | 判 |
|---|---|---|---|
| object/link 二分 + 一等链接 | ✅ | ✅（+struct 无身份嵌入值） | 对齐 |
| 属性元数据（display/desc/status 生命周期） | ✅ | ✅（experimental/active/deprecated 纯元数据） | 对齐 |
| 标量类型 | ~19 种（含受限：byte/short/float 不能进 action；decimal 不进 action；vector 只 KNN） | 9 种，无类型级受限位 | 对齐（v1 无 vector/二进制 → v2） |
| 接口/继承（多类型共享形状） | ✅ interfaces | ❌（struct 复用是唯一形状共享） | 空白 |
| n 元关系 / 链接属性 | link 仅二元（载荷靠 M:N + 中间对象同款模式） | 同构（「载荷升级」模式明文化） | 对齐 |
| 主键不可变 | ✅（改主键 = 破坏性重注册） | ✅（服务端 UUID，业务键 unique 分离） | 对齐 |
| code-first DSL 为第一公民 | ❌（UI/元数据服务为主，SuperRepo Beta） | ✅（TS DSL + push） | **反向** |

### 3.2 动作

| 项 | Palantir | Heirloom v1 | 判 |
|---|---|---|---|
| action = 唯一写路径 + 单事务 | ✅ | ✅（活事务） | 对齐 |
| 函数式 action（function rule 独占） | ✅ | ✅（v1 唯一形态） | 对齐 |
| **读己之写（同事务）** | ❌（官方文档明示无 RYW） | ✅ | **反向** |
| **同事务引用新建对象** | ❌（modify/delete 不能引用本事务新建） | ✅ | **反向** |
| 声明式规则编辑（7 种编辑型 + 参数映射） | ✅（低代码面） | ❌（只有函数式） | 空白（刻意：DSL 即低代码面） |
| submission criteria（提交前条件模板） | ✅（user/parameter/context 三类） | 部分（execute 内代码判断 + 白名单两层） | 砍→v2（ADR-0003 明确） |
| upsert | ✅（create-or-modify） | ❌（查-建两步，RYW 兜底） | 对齐（语义不同但有等价表达） |
| 副作用（notification/webhook/调度） | ✅ | ❌ | 砍→v2 |
| 幂等键 / operationId 轮询 | 部分（异步形态存在，幂等语义未公开） | ❌（重试语义已文档化：业务键兜底） | 砍→v2 |
| 动作批量（10k 对象/事务） | ✅ | 无显式上限（活事务天然边界） | 对齐（量级差异） |

### 3.3 逻辑（函数）

| 项 | Palantir | Heirloom v1 | 判 |
|---|---|---|---|
| 只读 queryFn 经 API 暴露 | ✅ | ✅（invoke 端点） | 对齐 |
| 函数被动作编排（调用桥） | ✅（decision graph） | ❌ | 砍→v2 |
| 函数注册表/类型对齐 | ✅ | ✅（DSL 参数幻影） | 对齐 |

### 3.4 安全

| 项 | Palantir | Heirloom v1 | 判 |
|---|---|---|---|
| 语义写路径统一授权（白名单） | ✅ | ✅（action-grants） | 对齐 |
| 实体级读授权（类型级 + 行级谓词） | ✅（marking/ACL 全家桶） | ✅（谓词编译进 SQL） | 对齐（机制同构、表达力差距大） |
| 行级谓词的 ctx 常量 | 类似 | ✅（ctx.userId/groups） | 对齐 |
| 静默收窄（零授权 = 200 空集） | ✅ | ✅ | 对齐 |
| scoped token（token 范围 ∩ 用户权限） | ✅（OSDK 双重叠加） | ❌（PAT = 全主体权限） | 空白 |
| 列级权限 | ✅（OSv2 多 datasource） | ❌ | 空白 |
| marking（安全标记体系） | ✅ | ❌（密级标记是建模模式） | 空白（自部署场景弱需求） |
| SSO/OIDC/LDAP | ✅ multipass | ❌（PAT + 超管引导） | 空白（v1 明确无登录流） |

### 3.5 引擎（读/写架构）

| 项 | Palantir | Heirloom v1 | 判 |
|---|---|---|---|
| 查询（过滤/排序/游标/include/聚合） | ✅（OSS，Spark 执行层） | ✅（查询包编译进 SQL；keyset） | 对齐（单 PG vs 分布式量级差） |
| 全文检索 / 聚合管道 | ✅ | ❌（contains 是 LIKE，无 FTS） | 空白 |
| 实时订阅（WebSocket 推送） | ✅（objectSet 订阅 + qos/降级语义） | ❌ | 砍→v2（PG 上可用 LSN/watermark 做更强重放——调研 B4 指出机会） |
| 物化/写回数据集（编辑历史重放） | ✅（OSv2 materializations） | n/a（对象表即权威态） | 设计差（v1 更简单；增量导出是空白） |
| 流/CDC 镜像 | ✅（Funnel） | ❌（外部同步器模式 + 水位线轮询） | 砍→v2 |
| 规模硬指标 | OSv2：单类型 2000 属性、10k 对象/action、Search Around 10 万对象 | 单表行宽软限（KB 级）、≤1000/接入批 | 对齐（目标量级不同） |
| 写可见性 | OSv1 最终一致 / OSv2 立即 | **提交即同步可见**（单 PG） | **反向** |
| 演化（三档分类 + revision） | Ontology Proposals（分支评审流） | push 期望态收敛（无分支评审） | 对齐（治理哲学不同：git 流 vs 平台流） |

### 3.6 工具链（OSDK）

| 项 | Palantir | Heirloom v1 | 判 |
|---|---|---|---|
| 类型化 SDK | ✅（生成式，TS/Java/Python/OpenAPI） | ✅（幻影直推，零 codegen，ADR-0009） | 对齐（路线不同：生成 vs 同源编译） |
| 多语言 | ✅ | ❌（仅 TS） | 空白 |
| 逐本体 OpenAPI 生成 | ✅ | ❌（静态面） | 砍→v2 |
| 生成式文档（按本体生成 API 文档） | ✅ | ❌ | 空白 |
| CLI（本体应用/导入/管理） | 部分 | ✅（1:1 薄壳） | 对齐 |

### 3.7 部署与运营

| 项 | Palantir | Heirloom v1 | 判 |
|---|---|---|---|
| 自部署 | 托管 SaaS 为主 | ✅ docker-compose / split 双形态 | **反向**（对自部署场景） |
| 运维面 | 平台替你运营 | 12-factor env + 前向迁移 + runbook | 对齐（形态不同） |
| 多租户 | ✅ | ❌（单租户） | 砍→（根决策） |

## 4. v0 遗物评估（埋葬 or 复活）

v0 白皮书 [part3](../whitepapers/part3-palantir-comparison.md) 的差异化设计，v1 规格砍掉了三件。逐个判决：

### 4.1 Abilities（类型级能力契约）—— **复活进 v2，但降格为「护栏」而非「权限」**

v0：Resource Type 声明 queryable/mutable/transferable/freezable/droppable，未声明 = 无角色可做。
判决：**值得复活**。它对 v1 体系是纯增量（DSL 加声明位 + push 时落库 + action 白名单校验时 AND 上类型能力），不破坏既有语义；而「类型系统的墙壁」是 v0 故事里唯一**机制层面**（非叙事层面）的差异化。v2 以「声明的能力面 = 可写的动作面」形态引入，服务于 Agent 治理叙事。
代价：又一层配置（v0 白皮书自己批评过 Palantir 两层配置的风险——复活时要设计成默认全开、显式收紧，避免配置地狱）。

### 4.2 链接三原语（Ownership/Reference/Association）—— **埋葬**

v0：链接带三种语义原语，级联/断裂/独立由类型告知 Agent。
判决：**埋葬**。v1 的删除语义（required 阻删 / optional 自动摘链）已经用基数 + required 表达了同样的信息，且是引擎强制而非文档约定；三原语是同一语义的另一种编码，复活 = 两套正交词汇说一件事。若 v2 需要显式级联策略，在链接声明上加 `onDelete: restrict|detach|cascade` 即可，不需要三原语的叙事重量。
保留遗产：v0 的「Agent 需要机器可读的级联语义」洞见，已被 v1 删除语义兑现。

### 4.3 Agent 一等公民（独立 Agent SDK / LLM-friendly 查询）—— **降格为「检验视角」，不作为平台构造**

v0：AI Agent 是首要设计目标，独立 Agent SDK。
判决：**降格**。v1 的结构化 JSON 查询 + 动作白名单 + PAT 已经是 Agent 可消费的（这正是 Palantir AIP 的接法）；独立 Agent SDK 层在 v1 体系里没有机制增量。正确姿势：把「Agent 视角」当验收视角——v2 的每个特性都问一句「Agent 消费这个特性的路径是什么」（如 S12 之于 SDK），而不是单造一层。
保留遗产：这个视角在 v2 规划里升格为一条**验收准则**（见 §6.4）。

## 5. 空白清单汇总（v1 无规划、且 Palantir 有）

1. **scoped token**（OSDK 的 token∩权限模型）——安全面最有价值的空白
2. **列级权限**——多值绑定单表存储后才有意义，暂缓
3. **接口/继承**——形状共享诉求真实存在，v2 语言候选
4. **全文检索**——依赖 PG FTS，中等工程量
5. **生成式文档**——静态 OpenAPI 已有，逐本体文档是自然延伸
6. **多语言 SDK**——codegen 路线（ADR-0009 已留缝：幻影直推与 codegen 不互斥，definition JSON 是现成输入）
7. **SSO/OIDC**——自部署企业场景的真实需求，但与「无登录流」根决策冲突，需重开决议

## 6. v2 候选优先级（输入，非决议）

| 优先 | 候选 | 理由 | 判据 |
|---|---|---|---|
| P0 | **workbench 建模工作台**（规格已写好） | 本体可视化编辑/浏览；规格面已存在（workbench-spec 十章），零决策成本启动 | workbench-spec 验收线 |
| P0 | **订阅（实时读）** | Agent/应用实时性刚需；PG LSN/watermark 可做**强于** Palantir 的重放语义（调研 B4） | 订阅 e2e 场景 |
| P1 | **动作副作用 + 写回编排** | 补齐动作支柱的本义（实时写回边缘系统是 Palantir 动作定义的一半）；webhook 起步 | 副作用语义 ADR |
| P1 | **GraphQL 线上面** | 既有决议（ADR-0008 → v2）；消费面扩张 | SDL/resolver 语义规格 |
| P2 | **接口/继承 + vector 标量** | 语言面补齐 | spec 10 修订 |
| P2 | **scoped token + 逐本体 OpenAPI** | 安全面 + 工具链补齐 | ADR-0010+ |

### 6.4 一条建议的验收准则（Agent 视角遗产）

> v2 每个新特性落地时，验收场景必须包含「AI Agent 作为消费者」的一条路径（工具白名单内的动作调用、谓词收窄下的查询、token 作用域）。

### 6.5 边界说明

AIP（Agent 平台）、Workshop/Quiver（应用搭建）、Pipeline Builder——Ontology 之上的产品层，不在本平台范围。Heirloom 的对应物是「SDK + CLI + REST」，应用层留给用户自己的代码。

## 7. 决策史

- 事实基础：[palantir-ontology.md](./palantir-ontology.md)（#2 调研，2026-08-16）；v0 对比篇见 [whitepapers/part3](../whitepapers/part3-palantir-comparison.md)（历史资料）。
- 本文档为 v2 规划输入；正式 v2 决议仍走 ADR 流程。
