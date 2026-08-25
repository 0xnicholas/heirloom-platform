# 第四部分：场景与用例

## 概述

前述三部分阐述了 Heirloom 的设计哲学、技术架构及其与 Palantir 的对比。本章以三个递进场景展示一个核心命题：**AI Agent 如何在一个类型安全的本体系统中，从被动查看到主动分析再到自主操作——每一步都在可审计、可约束的安全边界之内。**

三个场景共享同一组 Resource 定义，从「Agent 辅助人类查询」到「Agent 在人类监督下操作」到「Agent 被系统强制约束的越权防护」。

---

## 场景一：AI 供应链分析师——多源数据统一查询

### 1.1 设定

企业部署了一个 AI Agent——「供应链分析师」。它需要回答运营团队的自然语言问题，如「M001 物料在各仓库的库存和在途订单情况」。数据分散在四个异构系统中：

- 物料主数据：PostgreSQL（ERP）
- 实时库存：REST API（WMS）
- 传感器数据：Kafka 流
- 供应商交货：供应商 Portal API

### 1.2 Heirloom 建模

```yaml
resource Material:
  abilities: [key, store, query, freeze]
  fields: { code, name, unit, category }
  relationships:
    stocked_as: Reference ← Inventory

resource Inventory:
  abilities: [key, store, query, mutate, freeze]
  fields: { warehouse, quantity, safety_stock, last_counted }
  relationships:
    of_material: Reference → Material
  states: Active → Frozen

resource SupplierOrder:
  abilities: [key, store, query, mutate, transfer]
  fields: { po_number, quantity_ordered, eta, status }
  relationships:
    for_material: Reference → Material
    fulfilled_by: Association → Supplier
  states: Draft → Confirmed → InTransit → Received → Closed
          (Draft | Confirmed) → Cancelled → Destroyed
```

### 1.3 Agent 的 Role

```yaml
role SupplyChainAnalyst:
  scope: Ontology
  abilities:
    - query          # 可查询 Material, Inventory, SupplierOrder
    - action: notification.send  # 可发送通知
    # 注意：不包含 mutate, drop, freeze, transfer
```

### 1.4 交互过程

**用户**（在 Workshop 或聊天界面中）：「M001 的库存情况如何？有在途补货吗？」

**Agent 内部执行**：

```
步骤 1 — 查询物料（通过 Query Resolver 调用 Function 或直接语义查询）：
  POST /query
  { from: "Material", filter: { code: "M001" } }
  → { rid: "ri.material.001", name: "精密轴承 M001" }

步骤 2 — 查询库存（沿关系遍历）：
  POST /query
  { from: "Material", filter: { rid: "ri.material.001" },
    traverse: [{ path: "m --[stocked_as]← Inventory as inv" }] }
  → [
    { warehouse: "SH", quantity: 50, safety_stock: 100 },
    { warehouse: "BJ", quantity: 120, safety_stock: 100 }
  ]

步骤 3 — 查询在途订单（通过 Query Resolver）：
  POST /query
  { from: "SupplierOrder",
    filter: { for_material: "ri.material.001",
              status: { $in: ["Confirmed", "InTransit"] } } }
  → [{ po_number: "PO-8842", quantity: 200, eta: "2026-05-31" }]
```

**Agent 分析后回复**：「M001 精密轴承：上海仓 50 件（⚠️低于安全库存 100），北京仓 120 件（✓正常）。在途订单 PO-8842 预计 3 天后到货 200 件。建议通知上海仓跟进。」

此处 Agent 可以调用 Function 来计算更精确的库存覆盖天数：

```
调用 Function: inventory.coverage_days(inv: Inventory, material: Material)
→ 上海仓: coverage_days = 50 / (avg_daily_consumption) ≈ 5 天
→ 若在途 PO-8842 按期到达: coverage_days ≈ 25 天
```

**Agent 执行通知**（Notification Action，经用户确认后）：

```
POST /actions/notification.send
Body: { to: "warehouse_SH", template: "low_stock_alert",
        context: { material: "M001", gap: 50, eta: "3d", po: "PO-8842" } }

校验链:
  Capability: notification.send ✓ → 发送成功
  Event: 写入 Event Log（含 caller: agent, role: SupplyChainAnalyst）
```

### 1.5 关键演示

- **统一语义查询**：Agent 用三次结构化 JSON 查询，覆盖四个异构数据源——不需要知道任何数据库表名或 API 端点
- **权限控制**：Agent 只能 query 和 notification.send。它不能修改安全库存——即使它认为「调到 80 就能消除告警」更合理
- **完整审计**：每次查询和操作都产生事件。运营团队可以回溯 Agent 的完整决策链

---

## 场景二：客户 360——不同角色，不同视图（Agent 也在其中）

### 2.1 设定

同一个 `Customer#123`，在组织中有三类消费者：

- **销售 Agent**（Role: sales）——辅助销售团队分析客户，需要联系人和交易数据
- **财务团队**（人类 + 财务 Agent，Role: finance）——管理回款，需要发票和税务数据
- **合规 Agent**（Role: compliance）——自动审查数据存留，需要 GDPR 状态

### 2.2 Perspective Engine 自动裁剪

| 字段 | sales Agent | finance 团队 | compliance Agent |
|------|-----------|-------------|----------------|
| name, industry | ✓ | ✓ | — |
| contacts | ✓ | — | — |
| tier, arr | ✓ | — | — |
| invoice_total_due | — | ✓ | — |
| tax_id | — | ✓ | — |
| gdpr_status | — | — | ✓ |
| retention_policy | — | — | ✓ |

三个调用者用同一个 RID 查询 `Customer#123`，获得三个不同的 JSON 响应——**Agent 和人类没有区别，视角完全由 Role 决定**。

### 2.3 关键演示

- **Agent 的视角与人类一致**：合规 Agent 看不到销售字段，不是因为开发者给它写了一个过滤器——是因为它的 Role 定义中就没有这些字段的可见性
- **不可绕过**：Perspective Engine 的裁剪发生在 Query Resolver 内部，不是应用层的后处理。Agent 无法通过构造特殊查询来绕过字段限制
- **统一的治理模型**：新增敏感字段时，在 Resource Type 定义中声明可见性规则——Agent 和人类的访问自动同步更新

---

## 场景三：Agent 越权的系统级防护

### 3.1 设定

这是 Heirloom 与当前所有 Agent 框架最本质的差异演示。供应链分析师 Agent 在执行任务时，LLM 产生了两种「越界冲动」——一种是良性的（被系统允许），一种是危险的（被系统拒绝）。

### 3.2 被允许的操作

**Agent 分析**：「上海仓 M001 仅剩 50 件（安全库存 100），已通知仓库主管。但北京仓有 120 件——建议北京仓调拨 30 件到上海仓以覆盖缺口。」

Agent 只能 query 和 notification.send——它不能创建调拨单（需要 Inventory.mutate）。所以它通知了人类，建议人类来执行调拨操作。**这就是正确的 Agent 行为边界：分析、建议、通知——但不越权执行。**

```
POST /actions/notification.send
Body: { to: "inventory_controller",
        template: "transfer_suggestion",
        context: { from: "BJ", to: "SH", material: "M001", qty: 30 } }
→ ✓ 成功
```

### 3.3 被拒绝的操作

**LLM 幻觉**（同一会话中）：「用户看起来很着急。我直接帮他把上海仓的安全库存从 100 调到 80，暂时缓解告警吧。只是一次小小的配置调整。」

```
POST /actions/inventory.update_safety_stock
Body: { rid: "ri.inventory.sh.m001", safety_stock: 80 }

校验链:
  步骤 3 — Capability:
    update_safety_stock 需要 Inventory.mutate
    Agent 的 Role (SupplyChainAnalyst) 不包含 mutate → ❌ DENIED
  
  步骤 8 — Event (拒绝也被记录):
    { event_type: "action_denied",
      reason: "insufficient_capability",
      required: "Inventory.mutate",
      caller: "agent.supply_chain_analyst",
      caller_type: "agent",
      attempted_action: "inventory.update_safety_stock" }
```

Agent 收到 403。这不是 prompt 中「请勿修改数据」的结果——这是类型系统强制的结果。`Inventory` Resource Type 声明了 `mutate` ability，但 Agent 的 Role 中没有授予 `mutate` 的 Capability。两者之间的鸿沟是系统级的、不可绕过的。

### 3.4 关键演示

- **安全不依赖 Agent 自觉**：LLM 的幻觉是不可避免的。Heirloom 不试图训练 Agent 不产生越权冲动——它确保越权冲动在系统层被终止
- **能力在 Role，不在 prompt**：Agent 的安全边界定义在 Role 中，不是拼接在 system prompt 中的一段文字。Role 是结构化的、可审计的、可版本控制的
- **拒绝也是审计事件**：Agent 的每次被拒操作都被记录。安全团队可以在 Event Log 中查询：「这个月供应链分析师 Agent 尝试了多少次越权操作？趋势如何？」
- **渐进式信任**：组织可以从 `SupplyChainAnalyst`（仅 query + notification）开始，观察几个月。如果 Agent 的越权尝试次数在可接受范围，通过 Proposal 流程追加有限的 mutate 能力——每一步都有审计记录

---

## 三个场景的收敛

| 场景 | Agent 角色 | 演示的核心能力 |
|------|----------|-------------|
| 供应链分析 | 被动查询 + 建议 | 统一语义查询跨多源数据；Agent 的只读安全边界 |
| 客户 360 | 与人类共享 Role 的消费者 | Perspective Engine 使 Agent 和人类获得一致的视角裁剪 |
| 越权防护 | 产生幻觉并被系统拒绝 | Capability 校验是 Agent 安全的最后防线——不依赖 prompt、不依赖训练 |

三个场景共享同一组定义（Resource Types、Abilities、Roles、Actions），展示了从「Agent 能安全地看到什么」到「Agent 不能做什么」的完整安全光谱。核心结论不变：**不是训练 Agent 不越权，而是让越权在系统层面不可操作。**
