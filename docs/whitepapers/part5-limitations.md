# 第五部分：局限与非目标

## 概述

白皮书的可信度不仅在于它能清晰描述系统能做什么，更在于它诚实地声明系统不能做什么、不做什么、以及已知的代价是什么。本章从架构层面的固有取舍、明确的非目标和预期技术债务三个角度，划定 Heirloom 的边界。

---

## 1. 架构层面的固有代价

Heirloom 的每一项设计原则都代表了在某个维度上的主动取舍。这些取舍不会随着系统成熟而消失——它们是架构的固有属性。

### 1.1 写入延迟

每一次 Action 调用经过九步校验流水线（Auth → Role → Capability → Gate → State → Validate → Execute → Event → Notify），其中包含多次内部查询。对于高频写入场景（如每秒数千次的物联网传感器更新），这一开销是不可接受的。

**缓解方向**：批处理 Action（单次校验，批量执行同类型操作）。但批处理本身会牺牲单条记录的独立审计粒度。

### 1.2 关系语义的刚性

Ownership / Reference / Association 三种语义在建模时必须做出选择。在某些业务场景中，两个实体之间的关系可能同时具有多种语义特征。例如，Order 和 Customer 在大多数情况下是 Association（双方独立存活），但在欺诈调查场景中可能需要 Ownership 级别的生命周期耦合（客户被标记为欺诈后，其所有历史订单也需要被限制访问）。三种固定语义无法表达这种「上下文相关的语义变化」。

**缓解方向**：通过 Perspective Engine 在不同 Role 下展示不同的关系语义。但这只是视图层面的补偿，不改变底层存储的关系类型。

### 1.3 Schema Registry 的自举问题

Schema Registry 本身也是 Heirloom Resource——这意味着初始化 Heirloom 时需要先有一个已存在的 Schema 来定义 Schema Registry 自己的类型。这形成了一个引导困境。

**缓解方向**：系统内置一份硬编码的「最小引导 Schema」，用于启动 Schema Registry。一旦 Schema Registry 上线，引导 Schema 本身也可以被后续的 Proposal 修改和演化。

### 1.4 跨存储事务一致性

由于存储层采用了 Resource Store 和 Graph Store 分离的设计，一个 Action 可能同时写入文档（字段更新）和图（关系变更）。在没有原生分布式事务支持的情况下，两个存储之间的原子性由应用层保证（如 Saga 模式或补偿事务），这引入了最终一致性的窗口期。

**缓解方向**：Event Log 作为事务的「真相来源」——在写入路径中，先追加 Event，再分别更新 Resource Store 和 Graph Store。如果一个更新失败，Event Log 中的记录可用于修复不一致。

### 1.5 对业务建模者的前置要求

在 Heirloom 中开始使用数据之前，必须先完成 Resource Type 建模——定义 Abilities、状态机、关系语义。这与「先用起来再治理」的敏捷理念存在张力。建模者不仅需要理解业务领域，还需要理解 Heirloom 的类型系统设计哲学。

**缓解方向**：提供从现有数据库 Schema、GraphQL Schema 或 JSON Schema 自动推导初始 Resource Type 定义的工具。但自动推导的结果只能是起点，仍需人工审查和优化。

---

## 2. 明确的非目标

以下能力是 Heirloom **刻意不追求**的，避免系统边界无限扩张：

### 2.1 不替代数据仓库或数据湖

Heirloom 不负责海量数据的存储和 OLAP 分析。它不是 Snowflake 或 BigQuery 的替代品。Resource Store 存储的是语义实体本身，而非原始明细数据。大规模聚合分析应通过 BI Connector 连接到下游的专用分析引擎。

### 2.2 不替代 ETL / ELT 管道

Heirloom 的集成层提供基础的 Connector 和 Transform 能力，但它不是 DBT 或 Airflow 的替代品。复杂的数据清洗、多阶段转换和依赖管理应在 Heirloom 上游完成——Heirloom 接收的是「已可被映射为 Resource 的结构化数据」。

### 2.3 不替代 API 网关或服务网格

Heirloom 的消费层提供 REST / GraphQL 接口，但它不是面向微服务间通信的基础设施。Heirloom 的接口面向人类用户和 AI Agent——不面向微服务间的内部 RPC 调用。

### 2.4 不提供 AI Agent 的推理引擎

Heirloom 为 Agent 提供理解世界（语义原语）和操作世界（动力学原语）的能力，但不提供 Agent 的规划、推理、记忆和工具选择逻辑。Agent 的「大脑」是外部 LLM 或推理框架——Heirloom 是 Agent 的「手」和「眼」，而非「脑」。

### 2.5 不提供业务流程引擎（BPMN）

Heirloom 的状态机和 Event Log 可以支持基本的自动化，但它不是 Camunda 或 Temporal 的替代品。复杂的审批链、会签、超时回退、人工任务分配等 BPMN 级别能力不属于 Heirloom 的范围。Automation（基于 Event → Condition → Action 的编排）是组合能力，不是完备的工作流引擎。

---

## 3. 已知的演化挑战

以下是系统在未来的使用中预期会出现、但目前设计尚未完全解决的问题：

### 3.1 多 Ontology 间的互操作性

当前设计假定了一个单一的、企业级的 Ontology。但大型组织可能有多个部门级的 Ontology，各自独立建模，彼此之间存在概念重叠和语义冲突（如财务部门定义「客户」的方式与销售部门不同）。多 Ontology 之间的联邦查询、跨 Ontology 的 RID 映射、语义冲突解决——这些是当前设计的空白。

### 3.2 Abilities 的粒度扩展

当前的八种 Abilities 提供了粗粒度的类型级能力声明。在实际部署中可能出现「我需要允许 Agent 修改 Customer.tier，但不允许它修改 Customer.arr」的细粒度需求。是否需要在 Abilities 基础上引入「字段级能力」或「条件式能力」——这是未来需要权衡的问题（粒度越细，建模越复杂）。

### 3.3 Agent 行为的审计与异常检测

Event Log 记录了 Agent 的每一次操作和每一次被拒尝试，但原始事件流的体量可能迅速增长。如何从数百万条事件中识别出异常模式——某个 Agent 突然开始高频查询敏感字段、或在短时间内尝试了多种越权操作——需要审计分析工具的支持。当前设计仅提供了事件产生的机制，未提供事件分析的机制。

---

## 4. 不适用场景

重申第一部分中设计边界的判断，在此基础上进一步细化：

- **创业早期或小团队**：建模成本（定义 Resource Type、Abilities、状态机）在数据量小、团队信任度高的场景中超过收益
- **Agent 仅做只读分析的场景**：如果 Agent 不需要执行任何写入操作，直连数据仓库或通过 Cube.js 等语义查询层即可——Heirloom 的核心价值在于「安全地写入」
- **单一数据源、结构稳定的场景**：如果企业的所有数据都在一个 PostgreSQL 中，且 Schema 三年不变——不需要语义中枢的多源映射和 RID 稳定性
- **对延迟毫秒级敏感的高频交易场景**：九步校验流水线的延迟不可接受
