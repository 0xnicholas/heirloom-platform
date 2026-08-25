# 附录 B：术语表

## 核心概念

| 术语（EN） | 术语（中文） | 定义 |
|-----------|------------|------|
| **Resource** | 资源 | Heirloom 的一等业务实体。有全局唯一 RID、所有者、能力契约、状态机和事件历史。不是数据库行的投影，是独立的数字实体 |
| **RID** | 资源标识符 | Resource Identifier 的缩写。全局唯一、永不变化的实体标识符（如 `ri.customer.123`），不随数据源迁移而改变 |
| **Resource Type** | 资源类型 | Resource 的类型定义。声明该类型的所有字段、Abilities、状态机和可参与的 Relationship。如 `Customer`、`Order` |
| **Property / Field** | 属性 / 字段 | Resource Type 中定义的键值对数据，如 `Customer.name`、`Order.total` |

## 安全与权限

| 术语（EN） | 术语（中文） | 定义 |
|-----------|------------|------|
| **Ability** | 能力标记 | Resource Type 定义时声明的类型级契约，声明该类型的实例「允许发生什么」。八种：`key`、`store`、`query`、`mutate`、`transfer`、`copy`、`drop`、`freeze`。不是外部 RBAC 配置——是类型定义的一部分 |
| **Role** | 角色 | 在特定作用域（Ontology 全局 / Resource Type / Resource Instance）上被授予的一组能力捆绑。回答「你是谁」 |
| **Capability** | 能力票据 | 从 Role 派生的、对特定 Resource 的访问通行证。具有时效性和可撤销性。回答「你能做什么」 |
| **Scope** | 作用域 | Role 的授权范围：Ontology 级别（全局）、Resource Type 级别（如所有 Customer）、Resource Instance 级别（如特定 Customer#123） |

## 关系

| 术语（EN） | 术语（中文） | 定义 |
|-----------|------------|------|
| **Ownership** | 拥有关系 | 关系语义之一。被拥有方的生命周期受拥有方控制。拥有方删除时，被拥有方级联处理。所有权可被转移。权限沿 Ownership 链传播 |
| **Reference** | 引用关系 | 关系语义之一。引用方不控制被引用方。被引用方删除时，引用断裂（可检测），但引用方存续。权限不传播 |
| **Association** | 关联关系 | 关系语义之一。双方生命完全独立。任意一方删除不影响另一方。权限不传播 |

## 操作

| 术语（EN） | 术语（中文） | 定义 |
|-----------|------------|------|
| **Action** | 动作 | 结构化写入操作。接收 target Resource 和参数，经 Auth → Role → Capability → State → Validate 校验后执行变更并产生不可变审计事件。唯一的写操作入口。Notification Action 是其子类型——无 Resource target，仅产生外部通信副作用 |
| **Function** | 函数 | 本体原生的只读计算逻辑。接收对象或对象集作为输入，读取属性值，遍历关联，返回计算结果。不改变任何 Resource 状态。仅需 query Capability |
| **Notification Action** | 通知动作 | Action 的子类型。无 Resource target，不经过 State 和 Validate 步骤。产生外部通信副作用（发送消息、调用 webhook）。仍经过 Auth → Role → Capability → Event 链 |

## 架构与系统

| 术语（EN） | 术语（中文） | 定义 |
|-----------|------------|------|
| **Schema Registry** | 模式注册中心 | 管理所有 Resource Type 定义（字段、Abilities、状态机、Relationship、Roles）的权威来源。其内部数据本身也是 Heirloom Resource |
| **Mapping Engine** | 映射引擎 | 维护「业务字段 → 物理数据源」映射表的子系统。使 Agent 和人类用户不需要知道数据存储在哪 |
| **Query Resolver** | 查询解析器 | 将结构化 JSON 语义查询翻译为底层多源执行计划的子系统。支持过滤、路径遍历、聚合和语义搜索 |
| **Perspective Engine** | 视角引擎 | 在查询流水线最后一步基于调用者 Role 自动裁剪返回字段和关系的子系统。同一 RID，不同 Role 获得不同 JSON |
| **Event Log** | 事件日志 | 不可变操作事件流。记录每次 Action 执行（成功或被拒绝），构成完整审计链。支持时间范围查询和全量回放 |
| **Proposal** | 提案 | Schema 变更的治理机制。任何涉及 Resource Type 定义、Abilities、状态机或 Mapping 规则的变更，必须经提案 → 分支开发 → 评审 → 审批 → 合并流程 |
| **Connector** | 连接器 | 集成层的抽象接口。屏蔽不同数据源（PostgreSQL、REST API、Kafka、S3）的异构性，提供统一的数据接入方式 |
| **Transform** | 转换管道 | 将 Connector 产出的原始数据清洗、去重、字段映射和类型转换后写入存储层的处理管道 |

## 原语体系

| 术语（EN） | 术语（中文） | 定义 |
|-----------|------------|------|
| **Semantic Primitives** | 语义原语 | 描述「世界是什么」的原语集合。包括：Resource Type、Property/Field、Relationship、Abilities、State Machine、Role。Agent 通过语义原语理解业务领域 |
| **Kinetic Primitives** | 动力学原语 | 描述「世界如何改变与计算」的原语集合。包括：Action（写入操作）和 Function（只读计算）。Agent 通过动力学原语操作业务领域 |
| **State Machine** | 状态机 | Resource Type 定义的一部分。声明该类型的合法状态（Draft / Active / Frozen / Destroyed 及自定义中间态）和状态间的合法迁移路径。非法迁移在类型层被拒绝 |
