# 顾问建模工作台 · 规格说明书

> 大纲决议见 wayfinder 票 [#22 工具规格大纲与验收](https://github.com/0xnicholas/heirloom-pro/issues/22)（父图 [#16](https://github.com/0xnicholas/heirloom-pro/issues/16)）。基线：**吸收改写**（规格自包含为唯一权威；票决议与 research 分支为决策史）、**深规格工具版**（逐屏布局与交互、逐流程状态机、错误/边界清单；规范性措辞 加粗必须/不得/应当）、骨架先行（本目录）。撰写图外进行；实现库另建时本目录随迁（git 历史保留）。

| 章 | 文件 | 素材（吸收改写自） | 状态 |
|---|---|---|---|
| 0 概述 | [00-overview.md](00-overview.md) | 图 #16 根决策（伴侣工具/权威链不变/平台零改动） | **已撰写** |
| 10 工作坊工作流 | [10-workshop.md](10-workshop.md) | #19（单池双道/三幕/规则树/话术/CONTEXT.md 导出） | **已撰写** |
| 20 界面 | [20-interface.md](20-interface.md) | #21 裁决 C + [research/modeling-workbench-ux](https://github.com/0xnicholas/heirloom-pro/blob/research/modeling-workbench-ux/research/modeling-workbench-ux.md)（三戒/投影） | **已撰写** |
| 30 生成与预检 | [30-drafting.md](30-drafting.md) | #20（untracked/两层预检/同名红灯/贴回指引） | **已撰写** |
| 40 求值通道 | [40-eval-channel.md](40-eval-channel.md) | #18 T2（bun 子进程 extractor/合并求值）+ [research/dsl-draft-generation](../research/dsl-draft-generation.md) | **已撰写** |
| 50 技术栈与打包 | [50-stack.md](50-stack.md) | #23（React/reactflow/bun server/npm/前置）+ #18 T1/T3 | **已撰写** |
| 60 工作簿与数据模型 | [60-data.md](60-data.md) | #22 雾区定案（单文件 JSON/多场次/节点坐标/仅粘贴导入） | **已撰写** |
| 80 验收场景 | [80-acceptance.md](80-acceptance.md) | #22（W0–W8 + 覆盖矩阵，已播） | **已撰写**（矩阵规范性闭合 + 叙事） |
| 90 附录 | [90-appendix.md](90-appendix.md) | 各决议散点（重访条件/已知限制） | **已撰写** |

全部九章撰写完毕（2026-08-19）：W0–W8 覆盖矩阵闭合（自 #22 播骨架时即自闭合）+ 全部叙事——工作台规格达到完成判据（[00](00-overview.md) §5）。
