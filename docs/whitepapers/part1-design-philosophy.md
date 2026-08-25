# 第一部分：设计哲学与核心概念

## 1. 起点：AI Agent 需要什么样的数据界面？

企业 AI Agent 正在从「实验」走向「运营」。它们不再只是回答问题的聊天机器人——它们被期望查询库存、分析供应链瓶颈、触发审批流程、操作业务系统。但这种跃迁暴露了一个根本性的架构缺口。

当前给 Agent 提供数据访问的方式只有两种：**不给数据库权限（沙箱模式）**，或者 **给数据库直连权限（上帝模式）**。前者让 Agent 无用，后者让 Agent 危险。LLM 的幻觉可以变成一条 DROP TABLE；prompt 中的「请谨慎操作」是请求，不是约束。

问题的核心不在 AI 本身，而在 AI 与数据之间的**界面缺失**。人类用户有应用界面——表单有校验、按钮有权限、操作有审计。Agent 应该有什么？

Heirloom 的回答是：Agent 需要的是一个**以 Resource 为核心的、具有类型级安全保证的语义本体系统**。在这个系统中：

- Agent 不是直接操作数据库表，而是操作 **Resource**——有所有权、有能力契约、有状态机的业务实体
- Agent 能做什么，不由 prompt 定义，不由 API key 定义，由 **Resource Type 声明时内建的 Abilities** 决定
- Agent 的每一次操作，与人类用户一样经过统一的校验链——Auth → Role → Capability → Action

这不是 AI 安全方案。这是 AI 时代的数据架构方案。

---

## 2. 五条设计原则

每一条原则都有明确的获得与主动的放弃。理解这套设计的取舍，比记住概念本身更重要。

### 原则一：资源是一等实体，不是记录的投影

**我们选择**：每一个业务实体（客户、订单、物料、合同）在系统内拥有独立的、不随数据源变迁而改变的生命。它由一个全局唯一的 `RID`（Resource Identifier）标识，携带明确的所有者、声明式的能力契约、受约束的状态机和完整的事件历史。

**为什么对 AI Agent 重要**：Agent 需要一个稳定的「锚点」来理解和引用业务实体。如果 Agent 今天通过 PostgreSQL 主键引用客户，明天数据迁移到 BigQuery 后主键变了，Agent 的上下文就失效了。RID 让 Agent 可以用 `ri.customer.123` 永久引用同一个客户——无论底层数据源如何变迁。

**获得**：实体身份的稳定性——RID 不随数据源变化。关联不断、上下文不失效、审计链不中断。

**放弃**：简单数据的轻量感。一张 50 行的国家代码表若建模为 Resource，也须走完整的 RID + Owner + State + Events 流程。并非所有数据都值得这个重量。

---

### 原则二：能力在类型层声明，不在配置层授予

**我们选择**：在定义 Resource Type 时就声明它「允许发生什么」——能不能被查询（`query`）、能不能被修改（`mutate`）、能不能被转移所有权（`transfer`）、能不能被复制（`copy`）、能不能被删除（`drop`）、能不能被冻结（`freeze`）。这些 **Abilities** 是类型契约的一部分，不来自外部权限表。

**为什么对 AI Agent 重要**：这是 Heirloom 安全模型的核心。当前 Agent 安全的困境在于：安全保证要么依赖 prompt（可以被绕过）、要么依赖 API key 权限（粒度太粗）、要么依赖工具函数开发者的谨慎（人总会犯错）。Abilities 将安全保证从「人的谨慎」提升到「类型的强制」——如果一个 Resource Type 没有声明 `drop`，不存在任何方式让 Agent 删除它的实例。不是 Agent 被训练得好。是系统使删除不可表达。

**获得**：零信任 Agent 操作。系统安全边界不由 prompt、不由 API key、不由代码审查保证，而由类型系统强制执行。

**放弃**：紧急情况下的快速干预。需要临时给某个 Agent 或用户开后门做超出能力范围的操作？不可能——除非该类型自诞生之日起就携带对应 Ability。事后追加须走 Schema 变更提案流程。

---

### 原则三：状态迁移是可证明的，不是运行时检查的

**我们选择**：每个 Resource Type 声明自己的状态图——节点、合法的有向边、每条边对应的触发条件。非法迁移在提交时即被拒绝，不需要在 Action 代码中手写防御。

**为什么对 AI Agent 重要**：LLM 可能在任何时候产生幻觉说要「把已冻结的合同改回草稿状态继续修改」。在传统系统中，这个防御依赖开发者在 Action 代码里写 `if (status === 'frozen') return error`。Heirloom 将状态图编码为类型定义——你不需要记得写这个 if，因为状态图中没有 Frozen → Draft 的边。Agent 的幻觉在类型层就被终止。

**获得**：任何时刻可枚举一个 Resource 的合法状态。Agent 无法将实体推入非法状态——不是被 prompt 约束，是被状态图约束。

**放弃**：状态机的运行时灵活性。业务流程变化时需走 Proposal 重定义状态图，不能临时加 if。

---

### 原则四：关系语义决定生命周期联动

**我们选择**：三种精确语义，代替传统图数据库中的无差别「边」：

- **Ownership（拥有）**：被拥有方的生命周期受拥有方控制。拥有方删除时，被拥有方级联处理。所有权可被显式转移。
- **Reference（引用）**：引用方不控制被引用方。被引用方删除时，引用断裂（可检测、可告警），但引用方存续。
- **Association（关联）**：双方生命完全独立。任意一方删除不影响另一方。

**为什么对 AI Agent 重要**：Agent 在执行复杂任务时需要理解「删除 A 会不会影响 B」。对于人类，这是业务常识（删除客户，客户的所有地址也应该删掉）。对于 Agent，这必须是写在模型中的规则。三种关系语义将此编码为可机器理解的行为契约，Agent 不需要猜测级联后果——系统定义好了。

**获得**：Agent 执行写操作时，级联行为由关系语义自动决定，不会产生孤立数据或意外删除。

**放弃**：关系的模糊性。如果业务中某些 Order 可以脱离 Customer 独立存在，某些不能——系统强制选择一种语义。

---

### 原则五：操作需要能力，能力来自角色，Agent 与人类平权

**我们选择**：统一的访问控制链——`Actor → Role → Capability → Action`。Actor 可以是人类用户、AI Agent、自动化工作流。三者走完全相同的校验链。

- **Role**（角色）回答「你是谁」，在三个作用域上授予：Ontology 全局级、Resource Type 级（如 `Customer.Manager`）、Resource Instance 级（如 `Customer#123 的 Owner`）
- **Capability**（能力票据）从 Role 派生，是访问特定 Resource 的通行证，具有时效性和可撤销性
- **Action**（操作）是唯一的写入路径，内部包含验证规则、审批流、审计追踪和副作用

**为什么对 AI Agent 重要**：这是 Heirloom 区别于当前所有 Agent 安全方案的根本点。当前方案要么给 Agent 设置独立的安全策略（容易遗漏），要么不做区分（和人类混在一起，粒度不够）。Heirloom 的策略是：**Agent 和人类在同一个安全模型中，但在不同的 Role 上**。你可以创建一个 `SupplyChainAnalystAgent` 角色，它只能 query 物料、query 订单，以及调用 notification.send——碰不到任何 mutate、drop、freeze 操作。Agent 的行为边界不等于人类的边界，但遵循同一套规则引擎。

**获得**：Agent 安全与人类安全使用同一模型，减少安全策略的分裂。Agent 的每次操作可审计，被拒绝的操作也记入日志。

**放弃**：无摩擦的低延迟访问。每一次操作都经过多层校验。这是安全与性能之间的明确取舍——对于 Agent 的自主操作场景，这个取舍是合理的（Agent 的操作频率通常远低于人类 UI 交互）。

---

## 3. 核心概念

### 3.1 Resource（资源）

Resource 是 Heirloom 的一等业务实体——也是 AI Agent 理解和操作企业数据的唯一界面。每个 Resource 由以下要素构成：

| 要素 | 含义 | 对 AI Agent 的意义 |
|------|------|------------------|
| **rid** | 全局唯一、永不变化的 Resource Identifier | Agent 的稳定实体引用，不随数据源迁移而失效 |
| **type** | 所属 Resource Type，决定了 Abilities、状态机和可用字段 | Agent 理解实体的能力边界和可用属性 |
| **owner** | 资源的当前所有者。所有权可被显式转移 | Agent 查询所有权链以理解权限传播路径 |
| **state** | 当前生命周期状态（Draft / Active / Frozen / Destroyed） | Agent 的操作合法性可通过状态图预先判断 |
| **fields** | 键值对形式的业务属性 | Agent 可读写的结构化数据 |
| **relationships** | 指向其他 Resource 的关系（Ownership / Reference / Association） | Agent 遍历关系图以理解实体间的依赖和关联 |
| **events** | 不可变事件流，记录全部操作历史 | Agent 查询历史以获取上下文的时序信息 |
| **version** | 单调递增版本号，乐观锁基础 | Agent 检测并发冲突 |

### 3.2 Abilities（能力标记）

Abilities 是 Resource Type 定义时声明的类型级契约。它们回答了 Agent 最核心的安全问题：「我能对这个实体做什么？」

| Ability | 含义 | AI Agent 场景中的约束 |
|---------|------|---------------------|
| `key` | Resource 有全局唯一 RID，可被独立寻址 | Agent 可通过 RID 引用实体 |
| `store` | 可被嵌套在其他 Resource 内部 | Agent 可创建嵌套结构 |
| `query` | 可被搜索和列表查询 | Agent 可执行语义查询 |
| `mutate` | 字段可被修改 | Agent 可执行写入操作——**通常不应授予通用 Agent** |
| `transfer` | 所有权可被显式转移 | Agent 可变更所有权——**高风险操作** |
| `copy` | 可被克隆 | Agent 可复制实体——如从模板创建合同 |
| `drop` | 可被销毁（逻辑删除） | Agent 可删除实体——**通常绝不授予 Agent** |
| `freeze` | 可被冻结为不可变状态 | Agent 可归档实体 |

**这不是配置表。这是类型定义。** 一个 Resource Type 如果未声明 `drop`，则没有任何 Role——包括最高权限 Admin——能够创建可删除该类实例的操作。Agent 不可能「不小心删除了数据」，因为删除在该类型的语义空间中根本不存在。

### 3.3 Relationship（关系）

三种关系语义取代传统图模型中的无差别边：

| 关系类型 | 生命周期依赖 | 删除行为 | 权限传播 | 所有权转移 |
|---------|------------|---------|---------|-----------|
| **Ownership** | 被拥有方依赖拥有方 | 级联处理 | 拥有者的 Capability 向下传播 | 支持 |
| **Reference** | 被引用方不依赖引用方 | 引用断裂，被引用方保留 | 无传播 | 不支持 |
| **Association** | 双方独立 | 双方各自保留 | 无传播 | 不支持 |

**对 Agent 的意义**：Agent 在执行写操作前，可以通过关系语义预先判断操作的连锁影响——不需要查询文档或依赖训练数据中的模式匹配。

### 3.4 生命周期

Resource 的生命周期贯穿六个阶段：

1. **定义与建模**：Resource Type 的定义（含 Abilities、状态机、关系声明）
2. **数据实例化**：从原始数据源物化为 Resource 实例，确定初始 Owner
3. **状态交互**：所有变更通过 Action 层，受 Capability 校验
4. **自动化执行**：状态机迁移路径预声明，非法迁移被类型层拒绝
5. **治理与版本**：Schema 变更经 Proposal → 分支开发 → 审批 → 合并
6. **演化与反馈**：执行反馈驱动类型系统迭代，Agent 的使用模式反馈到能力审查

### 3.5 语义原语与动力学原语

前述核心概念可以收敛为两个正交的原语层：**语义原语**描述世界是什么，**动力学原语**描述世界如何改变与计算。这一划分是 Heirloom 类型系统架构的核心组织原则。

#### 3.5.1 语义原语（Semantic Primitives）—— 描述世界

语义原语定义「什么可以存在」。它们构成了 AI Agent 理解业务的静态词汇表：

| 语义原语 | 回答的问题 |
|---------|-----------|
| **Resource Type** | 系统中有哪些业务实体？ |
| **Property / Field** | 每个实体有哪些属性？ |
| **Relationship** | 实体之间如何关联？（Ownership / Reference / Association） |
| **Abilities** | 这个实体类型允许发生什么？（query / mutate / drop / freeze 等） |
| **State Machine** | 实体有哪些合法状态？状态之间如何迁移？ |
| **Role** | 谁在什么作用域（全局 / 类型 / 实例）上被授予了什么能力？ |

对 AI Agent 而言，语义原语是它的**世界模型**。Agent 通过查询 Schema Registry 获知 Customer 有 name 和 tier 两个属性、Customer 和 Order 之间是 Association 关系、Customer 的状态可以从 Active 迁移到 Frozen 但不能反向——这一切在 Agent 执行任何操作之前就已经确定。

#### 3.5.2 动力学原语（Kinetic Primitives）—— 改变与计算世界

动力学原语定义「什么可以发生」。它们是 Agent 与本体系统互动的唯一操作接口：

| 动力学原语 | 本质 | 副作用 | 子类型 |
|-----------|------|--------|--------|
| **Action** | 结构化写入操作。接收 target Resource 和参数，经过验证、审批、审计后执行变更 | 有（写入字段、推进状态、转移所有权） | **Notification Action**：无 Resource target，仅产生外部通信副作用（如发送消息、调用 webhook） |
| **Function** | 本体原生的计算逻辑。接收对象或对象集作为输入，读取属性值，返回计算结果 | 无（纯计算，不改变任何 Resource 状态） | — |

Action 和 Function 的区别：

| | Action | Function |
|------|--------|---------|
| 改变 Resource 状态？ | 是 | 否 |
| 需要 Capability？ | 是（按操作所需的 Ability，如 mutate / transfer / drop） | 是（仅需 query） |
| 产生审计事件？ | 强制 | 可选（高频调用可能不审计） |
| 可被谁调用？ | 人类、Agent、Automation | Action 内部、应用直接调用、Agent 直接调用 |
| 示例 | `update_tier()`、`approve_order()`、`transfer_ownership()` | `risk_score()`、`lifetime_value()`、`is_compliant()` |

#### 3.5.3 语义原语对动力学原语的约束

这是 Heirloom 类型安全的核心机制——**语义原语是动力学原语的硬边界**。任何 Action 或 Function 在定义时必须满足三条规则：

**规则一：Ability 门禁。** Action 声明 `requires: X`——该 Ability X 必须在 target Resource Type 的语义定义中已声明。如果 Customer 类型未声明 `drop`，则任何以 Customer 为 target 且 `requires: drop` 的 Action 在定义时即被拒绝。不可能存在一个「定义有效但因权限不足而无法执行」的 Action——无效的定义根本不会被注册。

**规则二：State 门禁。** Action 声明 `gate: state = Y`——该状态 Y 必须是 target Resource Type 的状态机中已定义的合法状态。状态机定义了 Active → Frozen 但没有定义 Frozen → Draft，那么声明 `gate: state = Draft` 且 target 状态要求为 Frozen 的 Action 在定义时即被拒绝。

**规则三：类型一致性。** Action 的 target 必须是已在 Schema Registry 中注册的 Resource Type。Action 的参数类型必须匹配该类型已定义的字段类型。Function 的输入对象类型和返回类型同样受此约束。

这三条规则确保：**任何动力学原语能做的事情，必然是语义原语已声明允许的事情。** 安全边界不在运行时，在定义时。

#### 3.5.4 非原语概念：Automation 与 Agent

某些概念虽然重要，但本身不是原语——它们是原语的组合或外部参与者：

**Automation** 不是独立的动力学原语。它在本质上是「Event Log 事件监听 + 条件判断 + Action/Function 调用链」的组合。Automation 使用 Action 和 Function 作为构建块，依赖 Event Log 作为触发器——它没有引入新的操作语义，而是编排了已有的原语。将 Automation 建模为组合而非原语，保持动力学层的简洁性和可分析性。

**AI Agent** 不是本体系统的内部概念。Agent 是本体系统的外部消费者——它与人类用户处于同一抽象层级。Agent 使用语义原语来理解世界（通过 Schema Registry 查询类型定义），使用动力学原语来操作世界（通过 Capability 校验链调用 Action 和 Function）。Agent 的规划、推理、工具选择、记忆管理不属于本体系统的范畴。但 Agent 被本体系统所约束——它只能使用语义原语已声明的东西，只能执行动力学原语已定义的操作，只能通过其 Role 已授予的 Capability 来调用。

---

## 4. 设计边界：什么场景适合这套模型

Heirloom 用开发速度和操作灵活性换取了可证明的正确性、完整的审计链和类型层面的 Agent 安全保障。这一取舍在以下场景是合理的：

**适用**：
- 企业部署 AI Agent 需要自主操作业务数据，但安全风险不可接受的场景
- 受监管行业，AI Agent 的每一次操作必须可审计、可回溯
- 多系统集成环境，Agent 需要一个跨系统的统一语义界面

**不适合**：
- 早期项目快速原型，Agent 操作范围小且风险可控
- Agent 仅做只读分析，不执行写操作的场景（此时直连数据仓库即可）
- 团队规模小、信任度高、不需要类型级安全保证的内部工具

---

Heirloom 的核心立场是：**当 AI Agent 从实验走向运营，安全不能再依赖 prompt 和自我约束。安全的根基必须在类型系统里——使有害操作不可表达。**
