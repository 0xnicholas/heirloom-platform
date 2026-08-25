# 附录

> **范围**：已知限制清单（各章汇总）、重访条件、运行前置汇总、冻结反应物与调研索引。
> **不含**：正文语义。
> **素材**：各章散点收口。
> **验收线**：深规格工具版（#22：总表归附录、单一权威）

## 1. 已知限制清单（单一权威；各章只引用）

| 领域 | 限制 | 章 | 去向 |
|---|---|---|---|
| 采集 | 客户资产导入仅粘贴多行（CSV/Excel 文件 → v2） | [10](10-workshop.md) §2.1 | v2 |
| 采集 | 判定重访的传播提示粒度随实现定 | [10](10-workshop.md) §3 | 实现 |
| 采集 | 术语表导出 v1 仅 Markdown | [10](10-workshop.md) §8 | v2 |
| 界面 | 无自动排布（力导向/自动分层） | [20](20-interface.md) §3.3 | v2 再议 |
| 界面 | 既有节点属性快捷件只出指引卡（无代码生成） | [20](20-interface.md) §4 | 重访 §2 |
| 界面 | 节点数软上限建议值随实现定 | [20](20-interface.md) §8 | 实现 |
| 界面 | 颜色方案未实测校准（#17 三项待验证：纯增量预览舒适度/ES 颜色移植/逐屏粒度） | [20](20-interface.md) §9 | 实现期实测 |
| 生成 | 同名/改名无自动重构（红灯 + 出路三选） | [30](30-drafting.md) §7 | 永久否决（工具层） |
| 生成 | 黄档命中面窄（迭代制下多数绿档；矩阵语义完整保留） | [30](30-drafting.md) §4 | 维持 |
| 生成 | unified diff 无块级视觉分层 | [30](30-drafting.md) §9 | v2 可选 |
| 求值 | 无增量求值（全量 60ms 级） | [40](40-eval-channel.md) §11 | 维持 |
| 求值 | 行级错误定位依赖平台 extractor 错误质量 | [40](40-eval-channel.md) §8 | 平台联动 |
| 求值 | 看门狗超时值随实现定 | [40](40-eval-channel.md) §9 | 实现 |
| 技术栈 | 无离线安装包（全链 npm） | [50](50-stack.md) §8 | v2 |
| 技术栈 | 浏览器兼容面未实测；平台包版本区间策略实现期定；多仓库多标签未定义 | [50](50-stack.md) §8 | 实现 |
| 数据 | 多实例并发仅警告级（无实时同步） | [60](60-data.md) §7 | v2 |
| 数据 | 场次快照无 diff 视图 | [60](60-data.md) §8 | v2 |
| 数据 | 工作簿默认 gitignore（治理字段全砍） | [60](60-data.md) §2 | 维持（定位使然） |

## 2. 重访条件（触发须新开决策，届时另图/另票）

| 条件 | 触发的重开 | 出处 |
|---|---|---|
| 图重开「改写既有块」 | 排版层升级 ts-morph（届时为正确工具） | #18 T1 / [30](30-drafting.md) §2 |
| 平台 DSL 出现 extend/组合构造 | 「既有类型修改」从指引卡升级为生成通道（草稿迭代制收缩） | [30](30-drafting.md) §2 |
| #21 视觉分层需要「块卡片 + 块内 diff」 | 启用 jsdiff `diffArrays` 块级 | #18 T3 / [30](30-drafting.md) §9 |
| 自动排布需求成立 | 力导向/自动分层进 v2 议程 | [20](20-interface.md) §3.3 |

## 3. 运行前置汇总（单一权威；[50](50-stack.md) §6 详表）

bun（首选：宿主 + 求值）· node+tsx（兜底求值）· 平台 CLI 包（npm 依赖，取 extractor）· 常青浏览器 · git（贴回面向，工具不调）。

## 4. 冻结反应物与调研索引（资料性）

| 位置 | 内容 | 规格锚点 |
|---|---|---|
| [`prototype/workbench-ui`](https://github.com/0xnicholas/heirloom-pro/tree/prototype/workbench-ui) | A/B/C 三变体（C 为定稿蓝本） | [20](20-interface.md) 全章 |
| [`prototype/ts-dsl-shape`](https://github.com/0xnicholas/heirloom-pro/blob/prototype/ts-dsl-shape/prototype/ts-dsl-shape/ontology.ts) | DSL 原型 + HR 示例本体（工作坊示例对齐） | [80](80-acceptance.md) |
| [`research/modeling-workbench-ux.md`](https://github.com/0xnicholas/heirloom-pro/blob/research/modeling-workbench-ux/research/modeling-workbench-ux.md)（归档分支） | UX 模式调研（实证标注） | [10](10-workshop.md)/[20](20-interface.md) |
| [`research/dsl-draft-generation.md`](../research/dsl-draft-generation.md) | 生成/求值/diff 技术调研（实证标注） | [30](30-drafting.md)/[40](40-eval-channel.md) |

## 5. 实现库迁移口径（#22 决议存档）

工具实现库另建时，本目录（`docs/workbench-spec/`）**随迁**（git 历史保留）；heirloom-pro 仓库保留规格的决策史（票 #16–#23 + research 分支）。

---
*决策史：#22（收口先例 + 迁移口径）、#18（重访条件）、各章「已知限制」节。*
