# Heirloom 规格说明书

> 大纲决议见 wayfinder 票 [#13 规格文档大纲与组织](https://github.com/0xnicholas/heirloom-pro/issues/13)。四项基线：**吸收改写**（规格自包含为唯一权威，ADR 降为决策史）、**目录分章**（章=文件）、**深规格**（逐端点表、逐条规范性陈述、示例内嵌、附录总表单一权威）、骨架先行（本目录）。
>
> 规范性措辞约定：加粗**必须** / **不得** / **应当**标记可测试的规范性陈述。

| 章 | 文件 | 素材 | 待落位 | 状态 |
|---|---|---|---|---|
| 0 概述 | [00-overview.md](00-overview.md) | 地图根决策、CONTEXT.md | 无 | **已撰写** |
| 1 总架构 | [01-architecture.md](01-architecture.md) | ADR-0006 | 无 | **已撰写** |
| 10 本体语言 | [10-language.md](10-language.md) | ADR-0001 + #12 | 无 | **已撰写** |
| 20 动作 | [20-actions.md](20-actions.md) | ADR-0003 | 无 | **已撰写** |
| 30 API 面 | [30-api.md](30-api.md) | ADR-0008 + 各 ADR 移交项 | 无 | **已撰写** |
| 40 存储引擎 | [40-engine.md](40-engine.md) | ADR-0002 | 无 | **已撰写** |
| 50 安全 | [50-security.md](50-security.md) | ADR-0004 | 无 | **已撰写** |
| 60 定义与演化 | [60-evolution.md](60-evolution.md) | ADR-0007 | 无 | **已撰写** |
| 70 接入与部署 | [70-operations.md](70-operations.md) | ADR-0005 | 无 | **已撰写** |
| 80 验收场景 | [80-scenarios.md](80-scenarios.md) | 全部 ADR + 冻结示例本体（#14 已落：S0–S11） | 无 | **已撰写**（矩阵规范性闭合 + 叙事） |
| 90 附录 | [90-appendix.md](90-appendix.md) | 各章散点收口 | 无 | **已撰写** |

「待落位」= 尚未关闭的 wayfinder 票，其决议须写入该章后方可宣布完成。撰写发生在图外（地图 Notes）。全部待落位票已关：**十一章全部撰写完毕（含 80 章叙事，2026-08-19）**，覆盖矩阵闭合——平台规格达到完成判据（[00](00-overview.md) §6）。
