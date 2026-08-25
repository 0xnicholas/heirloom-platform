# 附录：开源方案参照

## 概述

Heirloom 并非在真空中设计。业界已有多个项目在类型系统、图存储、元数据治理、语义查询和细粒度权限领域做出了重要探索。本附录选取四个最具参照价值的开源项目，从设计层面进行比较分析——重点评估每个项目在「AI Agent 作为数据消费者」这一未来场景下的适用性和局限。

---

## 1. TypeDB —— 最接近的类型系统设计

### 1.1 项目概要

TypeDB 是一个基于强类型系统的图数据库。它提供 entity、relation、attribute 三层抽象，支持类型继承、声明式规则推导和推理引擎。

### 1.2 核心设计

- **类型层次**：类型可继承，子类型自动继承父类型的所有属性和关系角色
- **关系作为超边**：relation 本身可以携带属性，解决「边不能带属性」的局限
- **声明式规则**：通过 `rule` 语法定义推理规则，系统自动推导新关系

### 1.3 Heirloom 借鉴了什么

- 关系携带属性——Heirloom 的 Relationship 继承了超边的表达能力
- Schema-first 建模——类型约束先于实例操作，与 Heirloom 的类型层安全理念一致

### 1.4 Heirloom 不同在哪里

- **无边端类型约束**：TypeDB 不区分 Ownership / Reference / Association——所有关系平等。Agent 无法从类型系统中获知级联行为
- **无 Abilities**：权限在数据库用户层。没有 `drop` / `freeze` / `transfer` 等能力标记。Agent 的权限边界在应用层，不在数据层
- **无 Action 概念**：只有查询和推理。Agent 无法通过系统原生的安全路径执行写操作

### 1.5 关键启示

TypeDB 的强类型系统服务于**查询正确性**。Heirloom 的强类型系统服务于**Agent 操作安全性**。前者确保数据不出错；后者确保 Agent 不越权。

---

## 2. DataHub —— 元数据治理的参照标杆

### 2.1 项目概要

DataHub 是 LinkedIn 开源的元数据管理平台，基于 GMA（Generalized Metadata Architecture）构建。提供数据集发现、数据血缘、业务词汇表和所有权管理。

### 2.2 核心设计

- **GMA 元数据即事件流**：元数据以事件流形式在系统中流转
- **数据血缘**：自动构建上游表→下游表→BI 报表的血缘关系
- **业务词汇表**：允许组织定义业务术语，并与物理数据集关联

### 2.3 Heirloom 借鉴了什么

- 事件流管理元数据的模式 → Heirloom 的 Event Log
- 所有权和领域的治理边界 → Heirloom 的 Ownership 关系语义
- 业务术语到物理数据的映射思路 → Heirloom 的 Mapping Engine

### 2.4 Heirloom 不同在哪里

- **管理元数据，不管理实体本身**：DataHub 描述「customer 表在哪里、谁负责它」，但不管理 customer 实例。Agent 如果接入 DataHub，仍然需要另一个系统来实际执行操作
- **无操作和状态机**：没有 Agent 可以安全调用的 Action 抽象
- **权限模型外置**：Agent 的安全边界不在元数据模型中

### 2.5 关键启示

DataHub 是数据的说明书。Heirloom 自身包含了元数据目录能力（对标 DataHub 和 OpenMetadata），让 Agent 知道「数据在哪、从哪来、靠不靠谱」。在此基础上，Heirloom 叠加了语义操作层——Agent 可以在类型级安全保证下操作数据。两者不是分工关系，Heirloom 是一个完整的平台。

---

## 3. Cube.js —— 语义查询层的成熟实践

### 3.1 项目概要

Cube.js 将「业务语义」翻译为「底层 SQL 查询」。开发者通过声明式 schema 定义 measures 和 dimensions，Cube.js 自动生成 SQL 并管理预聚合。

### 3.2 核心设计

- **声明式语义模型**：以 YAML/JavaScript 定义 Cube，内含 measures、dimensions、joins
- **自动 SQL 生成**：用户查询被翻译为含多表 JOIN 的 SQL
- **上下文感知的权限过滤**：基于用户上下文自动附加 WHERE 条件

### 3.3 Heirloom 借鉴了什么

- 语义查询 → 执行计划的翻译流程 → Heirloom 的 Query Resolver
- 上下文过滤 → Heirloom 的 Perspective Engine

### 3.4 Heirloom 不同在哪里

- **仅 OLAP，无写入**：Agent 无法通过 Cube.js 执行操作——它是只读的
- **无图遍历**：不支持深度路径遍历（「客户→订单→产品→供应商」）
- **单一数据源**：假定了数据在 SQL 数据库中

### 3.5 关键启示

Cube.js 在只读分析场景下证明了语义查询层的价值。Heirloom 将此模型扩展到读写混合、多数据源、Agent 操作的场景。

---

## 4. SpiceDB —— 细粒度权限的参照模型

### 4.1 项目概要

SpiceDB 是 Google Zanzibar 论文的开源实现，提供关系式细粒度权限管理。权限通过关系传播——「如果 A 是 B 的编辑者，B 是 C 的父文件夹，那么 A 对 C 有编辑权限」。

### 4.2 核心设计

- **关系式权限模型**：权限定义为 `(user, relation, object)` 三元组
- **权限传播**：通过关系链推导间接权限
- **声明式 Schema**：用 schema 文件定义权限关系

### 4.3 Heirloom 借鉴了什么

- 基于关系的权限传播 → Heirloom 的 Capability 沿 Ownership 链传播
- 声明式权限定义 → Heirloom 的「Abilities 在类型定义时声明」

### 4.4 Heirloom 不同在哪里

- **纯权限系统，不管理数据**：只回答「Alice 能不能对 Document#123 做 write」——不管 Document#123 是什么、在哪
- **Capability 从 Relationship 语义自动派生**：SpiceDB 的权限传播规则需手动编写。Heirloom 的 Ownership 天然传递 Capability——建模时说「Order 被 Customer 拥有」，权限传播规则就自动确定了
- **无类型层能力声明**：SpiceDB 的 relation 名称是开放集合。Heirloom 的 Abilities 是一组封闭的、有精确语义的能力标记

### 4.5 关键启示

SpiceDB 证明了权限的正确抽象不是「用户列表」而是「关系图」。Heirloom 在此之上更进一步：权限关系不应手工编织——它们应是 Resource Relationship 在权限维度的自然投射。当建模者说「这是 Ownership」时，权限、级联、转移规则全都有了——不需要再配一遍。

---

## 5. 综合对比

| 维度 | TypeDB | DataHub | Cube.js | SpiceDB | Heirloom |
|------|--------|---------|---------|---------|----------|
| **管理什么** | 数据+关系 | 元数据 | 分析查询 | 权限关系 | <strong>元数据 + 实体 + 操作 + 治理</strong> |
| **Agent 写入** | 无安全路径 | 无 | 无 | 无 | Action 唯一写入路径 |
| **Agent 安全层级** | 数据库用户 | 平台 RBAC | 上下文过滤 | 关系权限 | 类型层 Abilities + Role/Capability |
| **关系对 Agent 的意义** | 查询优化 | 血缘溯源 | 无 | 权限计算 | 级联行为+权限传播+实体引用 |
| **设计目标** | 图查询+推理 | 数据发现 | OLAP 分析 | 应用授权 | <strong>元数据发现 + AI Agent 安全操作企业数据</strong> |

### 5.1 总结

没有一个开源项目单独覆盖 Heirloom 的完整问题域。Heirloom 的存在理由在于：**自身提供完整的元数据管理能力（对标 DataHub/OpenMetadata），并在此基础上叠加语义操作层（类型级安全、Action 写入、状态机）——两者不是两个系统，是同一平台的两层。**

这个核心假设改变了一切：查询语言需要 LLM-friendly、安全需要在类型层面、关系语义需要机器可理解、审计需要覆盖 Agent 的每一次被拒尝试——而这一切都建立在对数据资产的完整元数据理解之上。
