# 第二部分：技术架构与原理

## 1. 架构总览：AI 原生的语义中枢（含元数据层）

Heirloom 的架构围绕一个核心设计决策展开：**语义中枢（含元数据发现能力）是人类和 AI Agent 共享的、唯一的数据操作界面**。不存在 Agent 专用的旁路或「内部 API」。这意味着：

- Agent 的查询和写入经过与人类完全相同的校验链
- Agent 的安全边界不是额外的配置层——它就是系统本身的安全模型
- 为 Agent 设计的能力（如语义搜索）同样可用于人类用户的自然语言查询

```
                    治理（纵轴：贯穿所有层）
                         │
┌──────────┐  ┌─────────────────────────┐  ┌──────────┐
│          │  │  ┌───────────────────┐  │  │          │
│ 数据世界  │  │  │   Schema Registry │  │  │ 业务世界  │
│          │  │  ├───────────────────┤  │  │          │
│ PostgreSQL│──│  │   Mapping Engine  │──│  │ AI Agent │
│ REST API │  │  ├───────────────────┤  │  │  (一等)   │
│  Kafka   │  │  │   Query Resolver  │  │  │ Workshop │
│    S3    │  │  ├───────────────────┤  │  │    BI    │
│          │  │  │ Perspective Engine│  │  │ 工作流    │
└──────────┘  │  └───────────────────┘  │  └──────────┘
              │      ▲ 语义中枢 ▲       │
              └─────────────────────────┘
```

语义中枢由五个子模块构成（原设计为四个，新增 Discovery Engine）：

| 模块 | 职责 | 对 AI Agent 的关键价值 |
|------|------|----------------------|
| **Schema Registry** | 管理 Resource Type 定义、Abilities、状态机 | Agent 通过 Schema 理解「系统中有哪些实体」「每个实体允许做什么」——这是 Agent 的运行时类型字典 |
| **Mapping Engine** | 维护「业务字段 → 数据源」的映射 | Agent 不需要知道数据在哪里。它查询 `Customer.tier`，Mapping Engine 负责找到 PostgreSQL 中的对应列 |
| **Query Resolver** | 将语义查询翻译为底层执行计划 | Agent 生成结构化的语义查询（JSON DSL），而非原始 SQL——既更安全，也更容易被 LLM 正确生成 |
| **Perspective Engine** | 基于调用者 Role 裁剪返回的属性和关系 | Agent 看到的数据受其 Role 约束——它不会被意外暴露超出其权限的敏感字段 |

---

## 2. 系统分层

```
┌─────────────────────────────────┐
│           消费层                 │  AI Agent SDK · Workshop · REST API · GraphQL · BI Connector
├─────────────────────────────────┤
│           操作层                 │  Action & Function 执行 · Capability 校验 · 状态机 · 审批流
├─────────────────────────────────┤
│       🔶  语义中枢  🔶          │  Schema Registry · Mapping Engine · Query Resolver · Perspective Engine
├─────────────────────────────────┤
│           存储层                 │  Resource Store · Graph Store · Event Log · Indexes
├─────────────────────────────────┤
│           集成层                 │  Connectors · Transforms · CDC · 增量同步
└─────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │      治理（纵轴）     │
              │  Proposals · Branching │
              │  Schema Versioning     │
              │  审计 & 合规           │
              └───────────────────────┘
```

### 2.1 集成层

集成层通过 **Connector** 抽象将多源异构数据引入 Heirloom：

- **DB Connector**：关系型数据库，支持全量加载 + CDC 增量同步
- **API Connector**：REST / GraphQL 端点，支持定时拉取和 webhook 推送
- **Stream Connector**：Kafka、Pulsar 等消息队列
- **File Connector**：S3、HDFS 上的 Parquet / CSV / JSON

经 **Transform** 管道（清洗、去重、映射、类型转换）后写入存储层。

### 2.2 存储层

多模态存储，按访问模式分离：

| 存储组件 | 内容 | 技术选型（参考） |
|---------|------|----------------|
| **Resource Store** | Resource 主体数据（字段、状态、版本） | 文档数据库 |
| **Graph Store** | Resource 间的关系 | 属性图数据库 |
| **Event Log** | 不可变操作事件流 | 日志存储 |
| **Indexes** | 属性索引、全文索引、向量索引（embedding） | Elasticsearch / pgvector |

### 2.3 消费层

消费层是对外暴露的接口。**AI Agent SDK 被列为首位**——这是 Heirloom 区别于传统本体系统的关键：

- **AI Agent SDK**：供 Agent 调用的结构化工具集，返回 JSON。Agent 通过它执行语义查询、调用 Function 进行计算、调用 Action 执行业务操作。SDK 本身不包含任何权限逻辑——所有权限校验在操作层完成
- **Workshop**：面向人类用户的低代码操作界面
- **REST API / GraphQL**：标准应用接口
- **BI Connector**：对接分析工具

### 2.4 操作层

操作层是动力学原语（Action 和 Function）的执行引擎。两种原语经过不同的校验路径：

**Action 校验流水线**（写入操作——改变 Resource 状态）：

```
API 请求（来自 Agent SDK、Workshop、REST API 等）
  │
  ├─ 1. Auth     解析调用者身份（人类 or Agent）
  ├─ 2. Role    查询调用者在目标作用域上的 Roles
  ├─ 3. Capability  从 Role 派生当前有效的 Capability
  ├─ 4. Gate     校验 Capability 是否覆盖请求的操作所需的 Ability
  ├─ 5. State    校验 target Resource 当前状态是否允许该操作
  ├─ 6. Validate 执行业务规则验证
  ├─ 7. Execute  写入 Resource Store + 更新索引
  ├─ 8. Event    追加不可变事件（含 caller 身份和所用 Role）
  └─ 9. Notify   发布变更事件（触发下游 Automation 和订阅者）
```

**Function 校验路径**（只读计算——不改变任何 Resource 状态）：

```
API 请求
  │
  ├─ 1. Auth     解析调用者身份
  ├─ 2. Role    查询调用者的 Roles
  ├─ 3. Capability  校验是否持有 query Capability（所有 Function 仅需 query）
  ├─ 4. Execute  执行计算逻辑（读取 Resource 属性、遍历关联、返回计算结果）
  └─ 5. (可选) Event  记录调用——高频 Function 调用可配置不产生审计事件以减少存储压力
```

**关键设计**：
- Function 不经过 State 检查——因为它是只读的，不改变 Resource 状态。无论 Resource 是 Active 还是 Frozen，Function 都可以被调用
- Action 必经完整九步流水线。被拒绝的操作同样产生事件——Event Log 不仅记录「谁做了什么」，也记录「谁尝试过但被拒绝了什么」。这对于 Agent 行为的审计和安全分析至关重要
- Notification Action 是 Action 的子类型——它没有 Resource target，因此跳过 State 和 Validate 步骤，但仍经过 Auth → Role → Capability → Event 链

### 2.5 治理（纵轴）

治理纵轴涵盖 Proposals（Schema 变更提案）、Branching（分支开发）、Schema Versioning 和审计。治理操作本身也受相同的 Abilities 模型约束——修改 Schema Registry 中的定义也需要相应 Capability。

---

## 3. 语义中枢详解

### 3.1 Schema Registry

Schema Registry 管理所有类型定义，包括 Resource Types、状态机、Relationships 和 Roles。**它是 Agent 理解「这个世界有什么」的运行时字典。** Agent 在规划操作前，可以通过 Schema Registry 查询：目标 Resource Type 有哪些属性？当前状态允许哪些迁移？自己持有的 Role 覆盖哪些 Capability？

Schema Registry 的内部数据本身也是 Heirloom Resource——即 Ontology 的元数据受 Ontology 自身治理。

### 3.2 Mapping Engine

Mapping Engine 维护「业务字段 → 物理数据源」的映射表。Agent 完全不需要感知这层的存在——它只知道 `Customer.tier`，不知道 `postgres://prod-db.customers.tier_column`。

### 3.3 Query Resolver

Query Resolver 将结构化的 JSON 语义查询翻译为底层执行计划。DSL 设计原则之一是 **LLM-friendly**——它可以被 Agent 可靠地生成和修改，不像 SQL 那样容易产生语法错误和注入风险。

**基础查询**：

```json
{
  "from": "Customer",
  "filter": { "tier": "enterprise" },
  "select": ["rid", "name", "arr"],
  "limit": 50
}
```

**路径遍历**（Agent 探索关系图）：

```json
{
  "from": "Customer",
  "alias": "c",
  "traverse": [
    {
      "path": "c --[placed]--> Order as o",
      "filter": { "o.status": "pending" },
      "traverse": [
        { "path": "o --[contains]--> Product as p" }
      ]
    }
  ],
  "select": ["c.name", "o.total", "p.name"],
  "limit": 100
}
```

**语义搜索**（Agent 的自然语言查询入口，向量 + 关键词混合）：

```json
{
  "from": "Customer",
  "search": {
    "type": "hybrid",
    "query": "快速增长的新能源企业",
    "properties": ["name", "description"],
    "min_score": 0.7
  },
  "select": ["rid", "name", "_score"],
  "limit": 10
}
```

**Resolver 内部流水线**：

1. **Parse & Validate**：验证类型存在、属性合法、路径语法正确
2. **Resolve Schema**：通过 Mapping Engine 查找底层数据源
3. **Rewrite**：将语义查询分解为子查询计划
4. **Execute**：并行执行，合并结果
5. **Perspective Filter**：根据 Role 裁剪字段和关系
6. **Return**：返回 JSON，附带 `_meta.version` 和 `_meta.state`

### 3.4 Perspective Engine

Perspective Engine 确保不同 Role 的调用者——**包括不同 Role 下的 AI Agent**——看到同一 Resource 的不同投影：同一 `Customer#123`，`sales` Role 看到联系人和信用额度，`finance` Role 看到发票和税务信息，`compliance` Role 看到 GDPR 状态。Agent 不会被意外暴露超出其 Role 范围的数据。

---

## 4. 写入路径详解（Agent 视角）

以「AI 供应链分析师 Agent 发送低库存告警通知」为例：

```
请求:
  POST /actions/notification.send
  Body: { to: "warehouse_manager", template: "low_stock_alert", ... }
  Caller: agent.supply_chain_analyst

步骤 1 — Auth:
  解析调用者: agent.supply_chain_analyst

步骤 2 — Role:
  查询该 Agent 的 Roles → SupplyChainAnalyst
  授予的 Capability: query(Material), query(Inventory), notification.send

步骤 3 — Capability:
  请求需要 notification.send → 持有 ✓

步骤 4 — Gate:
  通过

步骤 5 — State:
  notification 不是 Resource——无状态检查，通过

步骤 6 — Validate:
  模板 low_stock_alert 存在，参数合法 ✓

步骤 7 — Execute:
  发送通知

步骤 8 — Event:
  {
    event_type: "action_executed",
    action: "notification.send",
    caller: "agent.supply_chain_analyst",
    caller_type: "agent",
    role: "SupplyChainAnalyst",
    params: { ... }
  }

步骤 9 — Notify:
  无下游订阅

响应: { status: "sent" }
```

**对比：当 Agent 尝试越权时**：

```
POST /actions/inventory.update_safety_stock
Body: { rid: "ri.inventory.789", safety_stock: 80 }
Caller: agent.supply_chain_analyst

步骤 3 — Capability:
  inventory.update_safety_stock 需要 Inventory.mutate
  Agent 的 Role (SupplyChainAnalyst) 不包含 mutate → ❌ DENIED

步骤 8 — Event (拒绝也记录):
  {
    event_type: "action_denied",
    reason: "insufficient_capability",
    required: "Inventory.mutate",
    caller: "agent.supply_chain_analyst",
    caller_type: "agent"
  }
```

---

## 5. 架构设计的关键取舍

| 决策 | 获得 | 放弃 | 对 Agent 的意义 |
|------|------|------|---------------|
| 存储分离 | 按访问模式最优选型 | 跨存储事务复杂性 | Agent 的读路径可针对模式优化 |
| 九步校验 | 零越权、完整审计 | 每次写入有内部查询开销 | Agent 的操作天然可审计 |
| JSON DSL | LLM 友好、注入风险低 | 非图灵完备查询 | Agent 可以可靠生成，人类可审核 |
| Agent 无旁路 | 统一安全模型 | Agent 不能为性能绕过校验层 | 长期信任的基础 |
