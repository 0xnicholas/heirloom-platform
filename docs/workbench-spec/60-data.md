# 工作簿与数据模型

> **范围**：工作簿文件与所有权、术语条目字段集（裁剪版）、场次记录、节点坐标与画布状态、草稿 provenance、恢复语义、完整性边界。
> **不含**：DSL 定义 JSON（平台 [spec/60](../spec/60-evolution.md) §2 域）；server 读写职责（[50](50-stack.md) §3）。
> **素材**：[#22 雾区定案](https://github.com/0xnicholas/heirloom-pro/issues/22) + [#17](https://github.com/0xnicholas/heirloom-pro/blob/research/modeling-workbench-ux/research/modeling-workbench-ux.md) 字段集表。
> **验收线**：深规格工具版（#22：错误/边界清单）

## 1. 工作簿 = 仓库根单文件 JSON

- 路径：`<repo>/.heirloom-workbench.json`；**默认 gitignore**（本地工作态，不入客户仓库——工具**应当**在首启时自动追加该行到 `.gitignore`，已存在则跳过）。
- server 为**唯一写者**（[50](50-stack.md) §3）；写策略（normative）：**每次状态变更即原子写**（写临时文件 + rename），不留「保存」按钮——浏览器误关零损失（W8 的根据）。
- 版本字段 `version`（schema 版本，前向不兼容时提示迁移——v1 只有 `1`）。

```jsonc
// 形状总览（字段语义见下）
{
  "version": 1,
  "terms":   [ /* §2 术语条目 */ ],
  "sessions": [ /* §3 场次记录 */ ],
  "canvas":  { "nodes": { "<termKey>": { "x": 640, "y": 180 } } },   // §4
  "drafts":  [ /* §5 provenance */ ]
}
```

## 2. 术语条目字段集（#17 裁剪版；OpenMetadata 模板裁剪）

| 字段 | 必填 | 出现时机 | 说明 |
|---|---|---|---|
| `name`（apiName 来源） | ✓ | 倒词期 | 工具可从 displayName 自动生成 camelCase 建议（采纳前可改） |
| `displayName` | ✓ | 倒词期 | 中文人类名（平台双名制） |
| `definition` | — | 倒词期鼓励、判定期**必须**补齐 | 一句话定义（术语表工作法核心；未齐标「待补」） |
| `synonyms` | — | 判定期渐现 | 「客户叫它什么/文档里叫什么」的分歧记录 |
| `relatedTerms` | — | 判定期渐现 | 链接候选的温床（第二幕织网喂料） |
| `references` | — | 判定期渐现 | 客户既有词汇表/文档的溯源 |
| 候选分类 | ✓ | 倒词期 | 名词/动词/待定（轻标记三值，[10](10-workshop.md) §2） |
| 判定结果 | — | 判定期 | 规则树落点（object/struct/链接/动作…，含判定路径摘要） |

**砍掉**（normative）：owners/reviewers/status/approval 类治理字段——工作台是采集工具不是治理平台。

- 字段**随判定渐现**（节奏约束归 [10](10-workshop.md) §2；倒词期**不得**全量铺字段）。
- `name`/`displayName`/候选分类 与 #17 字段表一一对应；`definition` 的必填时机落定为**判定期**（#17 列必填、#19 列倒词期可选——按「倒词期零字段」节奏调谐为：倒词期鼓励、判定期强制补齐方可完成判定）。

## 3. 场次记录

```jsonc
{ "id": "s01", "date": "2026-08-19", "attendees": ["顾问×1", "HR 与项目侧×4"],
  "termSnapshot": { /* 本场结束时 terms 全量快照 */ },
  "notes": "第二幕织网进行到 员工↔项目" }
```

- 每场工作坊结束时**必须**落一条（含术语全量快照——逐场对照的根据）；`notes` 自由文本。
- 快照 = 当时 `terms` 数组原样深拷贝；不改写、不合并。

## 4. 画布状态（节点坐标）

- `canvas.nodes[termKey] = {x, y}`：手动布局的持久化（[20](20-interface.md) §3.3——摆放即工作坊信息）；zoom/视口中心**应当**一并持久化（重开还原现场感）。
- 坐标缺失的节点（新建未拖过）由 reactflow 置初始位（如原点堆叠 + 顾问拖开）——v1 无自动排布。

## 5. 草稿 provenance

```jsonc
{ "file": "ontology/hr.ts", "createdAt": "…", "status": "active" /* active|pasted|abandoned */ }
```

- 记录工具自产草稿文件（迭代制根据，[30](30-drafting.md) §2）：`active` = 未贴回可整体重生成；`pasted`/`abandoned` = 清账（不再重生成）。
- 状态迁移由工具判定：生成→`active`；检测到文件已不在（贴回后被 commit 合并或删除）→ 询问顾问标 `pasted` 或 `abandoned`（**不得**静默改）。

## 6. 恢复语义（W8）

- 重开 = `bunx heirloom-workbench <repo>` 载入工作簿：术语、判定、画布坐标、场次历史、草稿 provenance 全量还原。
- **工作簿 ≠ 注册表真身**：图谱现状仍以 extractor 求值为准（工作簿只存工具自产态）；两侧不一致（如手工删了已判定的类型）→ 图谱如实反映求值结果，判定条目标「落点已消失」提示。

## 7. 完整性边界（错误/边界清单）

| 情形 | 行为 |
|---|---|
| 工作簿不存在 | 首启正常态：初始化空簿 + gitignore 追加 |
| 工作簿 JSON 损坏 | 报错 + 备份原文件为 `.bak` 后重建空簿（**必须**先备份；不静默覆盖） |
| `version` 高于工具支持 | 提示升级工具，**不得**降级写 |
| 术语条目引用的草稿文件被手工删改 | 求值如实反映；provenance 状态询问（§5） |
| 并发实例（两标签页/两进程同 repo） | **应当**以文件锁或最后写入警告防互踩（v1 不做实时同步——本地单机场景，[90](90-appendix.md)） |

## 8. 已知限制与 v2（详见 [90](90-appendix.md)）

文件导入（CSV/Excel）→ v2；多实例并发仅警告级；快照无 diff 视图（逐场对照靠人工比对）。

---
*决策史：#22（雾区定案：单文件/多场次/坐标/仅粘贴）、#17（字段集表与节奏）、#19（CONTEXT.md 同构字段）、#23（坐标持久化联动）。*
