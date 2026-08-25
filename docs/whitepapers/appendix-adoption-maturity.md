# 附录 C：实施路径与成熟度模型

## 概述

Heirloom 的全面采纳需要组织在技术、流程和文化层面的配套变化。本附录提供一个四阶段的渐进式成熟度模型，帮助组织从「探索性引入」逐步过渡到「AI Agent 可信自治」。每个阶段定义了核心目标、典型配置和退出标准，不规定具体的时间线——采纳节奏取决于组织的规模、监管环境和对 Agent 自主操作的信任程度。

---

## 阶段一：语义查询层（Read-Only Semantic Layer）⭐

**目标**：在不动现有写入流程的前提下，建立一个统一的只读语义层，验证「多源数据 → 统一语义查询」的价值。

**典型配置**：
- 将 1-3 个核心业务域的数据源（如 CRM + ERP）通过 Connector 接入 Heirloom
- 为 3-5 个关键 Resource Type（如 Customer、Order、Product）建模
- 此时不定义强 Abilities（使用默认：key + store + query）
- 此时不启用 Action 层——所有写入仍走原有系统
- 消费层仅暴露 Query Resolver（语义查询）给分析师和仪表盘

**Agent 参与程度**：仅用于只读分析——Agent 可以查询但不能执行任何操作

**主要收益**：
- 验证 Mapping Engine 对现有数据源的兼容性
- 分析师和 Agent 获得统一的语义查询接口
- 识别建模中需要调整的关系语义（哪些是 Ownership，哪些是 Association）

**退出标准**：核心业务域的分析查询已稳定迁移到 Heirloom；建模团队熟悉了 Resource Type 定义流程

**预计投入**：1-2 个数据工程师 + 1 个业务领域专家，2-4 周建立第一个可用的语义查询层

---

## 阶段二：人类操作的安全写入（Human-Operated Actions）⭐⭐

**目标**：引入 Action 层作为写入操作的唯一入口，人类用户通过 Workshop 或 API 执行受 Capability 约束的写入操作。

**典型配置**：
- 为核心 Resource Type 定义完整的 Abilities 集合（包括 mutate、freeze、transfer、drop）
- 为写入场景创建 Action（如 `update_customer_tier`、`approve_order`）
- 定义基础 Role（Admin、Editor、Viewer）并分配 Capability
- 启用完整的九步 Action 校验流水线
- Event Log 开始记录所有写入操作和拒绝事件

**Agent 参与程度**：Agent 仍为只读——但可以调用 Function 进行辅助计算和决策建议

**主要收益**：
- 消除对底层数据库的直接 UPDATE 访问
- 建立完整的写入审计链
- 团队积累「如何正确定义 Abilities 和设置 Role」的经验

**退出标准**：核心写入操作稳定运行；Event Log 积累了足够的审计数据；团队熟悉 Role 和 Capability 的管理

**预计投入**：2-3 名工程师（含后端和数据建模）+ 安全/合规团队审查 Role 定义，4-8 周

---

## 阶段三：Agent 辅助操作（Agent-Assisted Operations）⭐⭐⭐

**目标**：AI Agent 成为正式的操作者——通过特定 Role 获得有限的 Capability，可以查询、计算、建议，并在人类确认后执行特定操作。

**典型配置**：
- 为 Agent 创建专用 Role（如 `SupplyChainAnalyst`、`ComplianceAuditor`），授予最小能力集（通常仅 query + 少量 Action 如 notification.send）
- Agent 通过 AI Agent SDK 调用语义查询、Function 和 Action
- Agent 的每次操作和被拒操作都进入 Event Log
- 建立 Agent 行为审计看板，监控越权尝试频率

**Agent 参与程度**：Agent 可以在其 Role 范围内自主执行 Function 和特定 Action。越权尝试被自动拒绝并记录

**主要收益**：
- Agent 开始产生实际运营价值（自动分析、告警、报告生成）
- 在真实环境中验证 Abilities 模型对 Agent 行为的约束效果
- 积累 Agent 行为数据用于未来的 Role 调整

**退出标准**：Agent 在其 Role 范围内稳定运行 3 个月以上；越权尝试率在可接受阈值内；审计团队确认 Agent 的 Event Log 无异常模式

**预计投入**：2-3 名工程师 + AI/ML 团队部署和维护 Agent，1 名安全/合规人员负责审计

---

## 阶段四：可信自治（Trusted Autonomy）⭐⭐⭐⭐

**目标**：Agent 在严格约束下被授予扩展的操作能力（包括有限的 mutate 和 transfer），能够在无需人类逐项确认的情况下执行预定义范围内的业务操作。

**典型配置**：
- 通过 Proposal 流程，为经过验证的 Agent Role 逐步追加有限的操作能力（如 `mutate` 仅限于特定字段、`transfer` 仅限于特定类型）
- 引入条件式能力限制（如「仅在工作日 9:00-18:00 可执行 mutate」或「仅对状态为 Draft 的订单可执行 mutate」）
- 部署高级 Agent 审计——异常行为自动告警、自动回滚或暂停 Agent 的 Role
- Agent 的使用模式反馈到 Role 定义的迭代中

**Agent 参与程度**：Agent 可以在其限定范围内自主操作，无需人类逐项确认。越权行为不可能发生（类型系统保证），异常但合法的操作被审计和标记

**主要收益**：
- Agent 承担低风险、高频率的运营操作（如自动更新库存状态、自动审批标准合同）
- 人类从操作执行者转变为治理者和异常处理者
- Role 的版本控制和 Audit Trail 使得 Agent 行为的监管可被外部审计

**退出标准**：持续演进，无固定终点

**预计投入**：持续运营和治理——Agent 和 Role 的生命周期管理成为组织的常态化工作

---

## 贯穿所有阶段的关键实践

- **从最小能力开始**：Agent 的初始 Role 授予 query + Function 调用能力，绝不在初期授予 mutate、drop 或 transfer
- **拒绝事件是第一手信号**：Agent 的越权尝试不是事故——它们是改进 Role 定义和训练数据的信号。高频拒绝 → 调整 Role 或向 Agent 提供更清晰的操作边界
- **Role 的版本控制**：每次 Role 调整走 Proposal 流程，记录变更原因和审批者。Agent 的能力扩展应该比人类更谨慎、更慢
- **不要跳过阶段一**：在未验证语义查询层的价值之前，不应投入 Action 层的建设。在未验证人类操作 Action 的安全模型之前，不应让 Agent 获得任何操作能力

---

## 何时止步

并非所有组织都需要到达阶段四。以下信号表明应停留在当前阶段：

- Agent 的越权尝试频率持续上升 → 回到阶段三，缩小 Agent Role
- 业务领域的建模复杂度超出团队能力 → 回到阶段一，简化 Resource Type 定义
- 审计发现在当前阶段已存在无法解释的异常 → 冻结 Agent 操作（通过临时移除其 Role）直至问题解决
- 组织的合规/监管环境发生变化 → 重新评估 Agent 可获得的最高能力水平
