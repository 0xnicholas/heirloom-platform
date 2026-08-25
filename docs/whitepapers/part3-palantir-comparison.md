# 第三部分：与 Palantir Ontology 对比

## 概述

Palantir Ontology 是迄今为止最成熟的企业级语义本体系统。近年来，Palantir 通过 AIP（Artificial Intelligence Platform）将 AI Agent 集成到 Ontology 之上——Agent 通过 Action Types 操作业务对象，通过 Ontology SDK 查询数据。

Heirloom 与 Palantir 共享这一基本范式：**AI Agent 不应直连数据库，而应通过语义本体层进行操作**。但在这一共识之上，二者在「本体层应提供什么级别的安全保证」和「AI Agent 是否被作为一等设计目标」这两个问题上选择了不同的路径。

---

## 1. 共同基础

- **语义层作为数据与应用的中间层**：下游应用和 AI Agent 通过 Ontology 操作数据，不直连底层数据源
- **Action 作为唯一写入路径**：所有变更经 Action 完成，附带验证、审批和审计
- **Ontology Proposals 分支治理**：Schema 变更经分支开发 → 提案 → 评审 → 合并流程
- **RID 作为全局唯一标识**：Agent 可以通过 RID 稳定引用业务实体

---

## 2. 五个核心分歧

### 分歧一：AI Agent 是一等公民还是后加消费者？

| | Palantir | Heirloom |
|------|---------|----------|
| **设计时序** | Ontology 先于 AIP 存在。Ontology 最初为人类用户（Workshop）设计，AI Agent 是后来集成的消费者 | 从第一天起，AI Agent 就是系统的目标消费者——与人类用户平级 |
| **消费层设计** | AIP 提供独立的 Agent SDK 和工具调用层，叠加在 Ontology 之上 | 消费层中 AI Agent SDK 列为首位。语义查询 DSL 被设计为 LLM-friendly——结构化 JSON 而非文本模板 |
| **安全模型的一致性** | AIP Agent 的安全策略与人类用户的 Sharing/RBAC 可以不同。Agent 可以有独立的工具白名单 | Agent 和人类走完全相同的 Auth → Role → Capability → Action 流水线。Agent 的边界是 Role 的边界，没有额外的「Agent 专用安全层」 |

**分歧的实质**：Palantir 的 AI 能力是「在已有本体系统上开通了 Agent 接口」。Heirloom 是「以 Agent 为目标消费者设计了整个本体系统」。

**后果**：Heirloom 的 Query DSL（结构化 JSON）比 Palantir 的 OSS 查询更容易被 LLM 可靠生成。Heirloom 的统一校验链意味着不存在「Agent 安全策略和人类安全策略不一致」的配置错误风险。

---

### 分歧二：权限的位置——外部配置还是类型契约？

| | Palantir | Heirloom |
|------|---------|----------|
| **权限定义** | 与 Resource Type 分离，在独立的 Sharing / RBAC 中管理 | Abilities 是 Resource Type 定义的一部分 |
| **Agent 安全保证的层级** | AIP 的 Agent 工具白名单 + 底层的 Sharing/RBAC 策略——两层配置，任何一层配置失误都可能导致越权 | Agent 的 Role 是唯一的权限来源。如果 Resource Type 未声明 `drop`，没有任何 Role 能授予 Agent 删除能力——不存在「两层配置中有一层配错」的风险 |
| **事后追加权限** | 可随时添加新的 Sharing 规则 | 追加新 Ability 需 Schema 变更提案——主动设计的摩擦 |

**分歧的实质**：Palantir 的安全是「可配置的围墙」——围墙的设计影响安全性。Heirloom 的安全是「类型系统的墙壁」——有些方向根本没有门。

**对 Agent 的意义**：Heirloom 的 Agent 安全不由运维团队「配得是否正确」决定，由开发团队「类型的定义是什么」决定——这更接近 DevSecOps 的「安全左移」理念。

---

### 分歧三：关系的语义——扁平边还是三级区分？

| | Palantir | Heirloom |
|------|---------|----------|
| **关系模型** | Link Type：有向有类型的边，所有边等价 | Ownership / Reference / Association 三种语义原语 |
| **Agent 对级联行为的理解** | Agent 需要在训练或上下文中学习「删除客户会不会影响订单」——这是业务知识，不在模型中 | 关系语义直接告诉 Agent：Ownership = 级联、Reference = 断裂、Association = 独立。Agent 不需要猜测 |
| **权限传播** | Sharing 规则手动配置 | Ownership 链自动传播 Capability |

**对 Agent 的意义**：当 Agent 需要自主决策「我可以对这个实体的关联实体做什么」时，Heirloom 的答案来自类型系统（可查询、可预测），Palantir 的答案来自业务知识（依赖 Agent 的训练质量或上下文）。

---

### 分歧四：状态迁移的保证

| | Palantir | Heirloom |
|------|---------|----------|
| **状态定义** | Property 表达 + Action 代码检查 | 类型定义层声明状态图 |
| **Agent 进入非法状态的可能性** | 取决于 Action 开发者是否记得写状态检查 | 不可能——状态图中不存在的边无法执行 |

**对 Agent 的意义**：LLM 产生幻觉时可能提议「把已归档的合同改回草稿」。在 Palantir，这取决于该合同的 Action 代码是否做了状态检查。在 Heirloom，状态图中没有 Frozen → Draft 的边——Agent 的请求在类型层被拒，与代码质量无关。

---

### 分歧五：对象本质——记录投影还是独立实体？

| | Palantir | Heirloom |
|------|---------|----------|
| **本体论定位** | Object = 数据源的记录 + 语义标签 | Resource = 独立数字实体，RID 不随数据源变化 |
| **对 Agent 的影响** | Agent 引用的 Object 可能因数据源迁移而失效（RID 可能基于数据源主键） | Agent 的 RID 引用永不过期——Agent 的长期记忆和上下文可以安全依赖 RID |

---

## 3. 为什么选择这些分歧

Heirloom 与 Palantir 的差异源于一个统一的判断：**当 AI Agent 成为企业数据的主要消费者，本体系统需要从「为人设计、AI 可用」转向「为 AI 和人共同设计」**。这意味着：

- 查询语言需要对 LLM 友好（结构化 JSON 而非自由文本）
- 安全模型需要在类型层面而非配置层面防止 Agent 越权
- 状态和关系语义需要机器可理解——Agent 不能依赖「业务常识」
- 实体身份需要超越数据源——Agent 的长期记忆不能随 ETL 管道变化而失效

Palantir 在「为人设计」上做到了极致。Heirloom 在尝试「为 AI 和人共同设计」——保留被验证的骨架，在 AI 安全、Agent 理解和长期可靠性上引入更强的约束。

---

## 4. 对比总结

| 维度 | Palantir | Heirloom | 对 AI Agent 的核心影响 |
|------|---------|----------|----------------------|
| Agent 设计优先级 | 后加消费者 | 一等目标消费者 | Agent 接口和 DSL 的 LLM 友好度 |
| 权限位置 | 外部 RBAC | 类型层 Abilities | Agent 越权的防护层级 |
| 关系语义 | 通用边 | 三级区分 | Agent 理解级联行为的方式 |
| 状态保证 | 编码约定 | 类型声明 | Agent 推进非法状态的可能性 |
| 实体身份 | 数据源依赖 | 独立 RID | Agent 长期记忆的稳定性 |
| 校验链 | Agent 和人类可分离 | Agent 和人类统一 | 安全策略的一致性 |

### 4.1 定位差异

Heirloom 不是在做一个开源的 Palantir 替代品。二者的差异反映了对「下一代语义本体系统」的不同想象：**Palantir 将 AI 视为本体系统的增强功能；Heirloom 将 AI Agent 视为本体系统的首要消费者。**
