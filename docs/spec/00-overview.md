# 概述

> **范围**：系统定位（对标 Palantir Foundry Ontology、每支柱砍到最小可用）、根决策清单、规格结构与阅读路径、范围与非目标、术语速览、完成判据。
> **不含**：各章细节。
> **素材**：[地图 #1](https://github.com/0xnicholas/heirloom-pro/issues/1) 根决策、CONTEXT.md。
> **待落位**：无。
> **验收线**：深规格（[#13](https://github.com/0xnicholas/heirloom-pro/issues/13) 决议：逐条规范性陈述、总表归 [90](90-appendix.md)）

## 1. Heirloom 是什么

Heirloom：**通用自部署开源平台**，让团队以代码（TS DSL）定义领域本体，在其上获得受治理的读写 API、动作与权限。参照系 = Palantir Foundry [Ontology](https://www.palantir.com/docs/foundry/architecture-center/ontology-system) 四支柱，**每支柱砍到最小可用**：

| 支柱 | Palantir Foundry | Heirloom v1 切割 | 详述 |
|---|---|---|---|
| 数据 | Ontology 类型/链接/数据接入 | **完整**：TS DSL 本体 + 一等链接 + 接入端点 | [10](10-language.md) / [70](70-operations.md) |
| 动作 | Action（单事务→实时写回边缘系统） | **完整但只写本体**：函数式动作 + 活事务；写回/多步编排 → v2 | [20](20-actions.md) |
| 逻辑 | Functions（被动作编排） | **只留接口位**：只读 queryFn 同步执行 | [20](20-actions.md) §11 |
| 安全 | Marking / 行级 ACL / Foundry 授权栈 | **实体级 RBAC**：类型级 + 谓词式行级 + 动作白名单 | [50](50-security.md) |

- 第一界面 = **SDK + API**（TS DSL + REST；v1 **无 UI**——可视化编辑器/对象浏览器 → v2+ 从 API 派生）。
- 单租户、自部署、单 Postgres；无多租户 SaaS、无分布式引擎（§5）。

## 2. 根决策（建图锁定，规格前提）

| 决策 | 值 | 背书 |
|---|---|---|
| 交付物 | 规格说明书（实现交后续；本仓库纯文档） | 地图终点 |
| 用户 | 通用自部署平台（非垂直领域绑定） | 地图根决策 |
| 范围 | 数据+动作完整、逻辑只留接口位、安全实体级 RBAC | 地图根决策 |
| 第一界面 | SDK + API，v1 无 UI | 地图根决策 |
| 线上面 | TS DSL + **REST**（GraphQL → v2） | ADR-0008 修订 |
| 技术栈 | **TypeScript 全栈 + 单 Postgres** | ADR-0006（含四条重访条件，[90](90-appendix.md)） |
| 命名 | Heirloom | 地图根决策 |

## 3. 规格结构与阅读路径

十一章 = 本目录（索引见 [README](README.md)）。建议路径：

- **实现者**：[01 总架构](01-architecture.md) → [10 语言](10-language.md) → [40 引擎](40-engine.md) → [20 动作](20-actions.md) → [30 API](30-api.md) → [60 演化](60-evolution.md)
- **运维者**：[70 接入与部署](70-operations.md) → [50 安全](50-security.md) → 30 §4 管理面
- **验收**：[80 验收场景](80-scenarios.md)（覆盖矩阵为规范性完成判据，§6）

本规格自包含、为「是什么」的唯一权威；[docs/adr/](../adr/)（八份）降为决策史（「为什么」），各章末「决策史」行指回。

## 4. Palantir 对齐/偏离总表

| Palantir 机制 | Heirloom v1 | 对齐/偏离 |
|---|---|---|
| Ontology 类型系统（object/link 二分） | 同构（object/struct 二分 + 一等链接） | 对齐 |
| Action 单事务显式动词、校验结果在响应体 | 同构（ValidationFailed 逐字段、200/422 语义） | 对齐 |
| 函数须包装为 action 才能写 | 同构（语义层唯一写路径 = 动作） | 对齐 |
| 管道写入不经本体动作 | 接入端点走引擎通道 | 对齐 |
| Data Connection 托管同步器 | 模式级（外部进程 + 水位线轮询） | 偏离（托管规格面最重） |
| 全量数据 lineage/审计 | 批次级导入审计 + 动作审计 | 弱化 |
| Foundry 托管 SaaS | 自部署 docker-compose 单 PG | 偏离（根决策） |

（逐支柱明细表见 ADR-0003/0005 各自对齐节。）

## 5. 范围与非目标（吸收地图 Out of scope）

以下显式出界，各条的去向：

| 项 | 去向 |
|---|---|
| v2 语言构造（继承/接口、n 元关系、链接属性、vector/二进制标量） | v2（[10](10-language.md) §8） |
| 可视化 UI（本体编辑器/对象浏览器） | v2+ 从 API 派生 |
| 多语言 SDK（Python/Go 等） | v2+ |
| 多租户 SaaS 形态 | 边界外（v1 单租户自部署） |
| 分布式/分片引擎、CDC 级实时镜像 | 边界外（v1 单 Postgres） |
| 动作副作用规则、外部写回、多步编排、动作↔函数调用桥、幂等键 | v2（[20](20-actions.md) §12） |
| GraphQL 线上面、逐本体 OpenAPI 生成 | v2（[30](30-api.md) §8） |
| OIDC/外部 IdP、自管密码登录、授权声明式导入（DSL sync） | v2（[50](50-security.md) §11） |
| 迁移脚本语言、`--allow-data-loss` 强制通道 | 永久否决（非推迟，[60](60-evolution.md) §5） |

## 6. 完成判据（normative）

- 深规格验收线（[#13](https://github.com/0xnicholas/heirloom-pro/issues/13)）：逐端点表、逐条规范性陈述（加粗**必须/不得/应当**）、示例内嵌、总表归 [90](90-appendix.md) 单一权威。
- **覆盖矩阵闭合 = 规格完成的硬验收**：每条决议点至少被一条故事锚定（[80](80-scenarios.md)）；矩阵不闭合，规格不得宣布完成。

## 7. 术语速览（详述指向各章）

| 术语 | 一句话 | 详述 |
|---|---|---|
| 对象类型 | 有 UUID 身份、可链接、可独立查询与授权的实体类型 | [10](10-language.md) §2 |
| 结构类型（struct） | 无身份嵌入值，可复用可嵌套，v1 唯一形状共享机制 | [10](10-language.md) §2 |
| 属性 / 九类标量 | 值承载；默认可选、就地约束；decimal 走 JSON 字符串 | [10](10-language.md) §3 |
| 链接 | 对象间引用的一等声明：1:1/1:N/M:N、无载荷、双侧游走 | [10](10-language.md) §4 |
| 业务键 | `unique` 约束声明的业务标识，非主键 | [10](10-language.md) §3.2 |
| 对象 ID | 服务端生成 UUIDv7，创建后不可变、对外不透明 | [10](10-language.md) §5 |
| 命名元数据 / status | apiName + displayName + description；status 三值纯元数据 | [10](10-language.md) §1 / [60](60-evolution.md) §6 |
| 动作 | 语义层唯一写路径：命名 + 类型化参数 + 单事务 `execute` | [20](20-actions.md) §1 |
| 活事务 | execute 全程同一事务：RYW、同事务引用、返回即提交 | [20](20-actions.md) §6 |
| 编辑操作 | create / modify / delete / link / unlink 五件套 | [20](20-actions.md) §5 |
| 校验失败（ValidationFailed） | execute 内抛出的逐字段结构化异常 → 422 | [20](20-actions.md) §4 |
| 审计日志 | 已提交动作的只追加记录（+ 导入批次条目），治理轨迹权威源 | [20](20-actions.md) §10 |
| 只读函数（queryFn） | 逻辑支柱 v1 唯一接口位：与 action 同构、只读 `q` | [20](20-actions.md) §11 |
| 主体 / 超管 | 用户/组/服务账号（引擎内置）；isAdmin 绕过一切检查 | [50](50-security.md) §2–3 |
| 读授权 / 行级谓词 | 类型级 + 谓词式行级（算子同源 + ctx 常量，编译进 SQL） | [50](50-security.md) §5–6 |
| 动作白名单 / PermissionDenied | 写路径两层授权：引擎层白名单 / 代码层自判 | [50](50-security.md) §8 |
| PAT | v1 唯一凭据：服务端签发不透明 token，Bearer 传递 | [50](50-security.md) §4 |
| 安全日志 | 认证失败与授权拒绝的只追加记录，与审计分立 | [50](50-security.md) §10 |
| 本体推送（push） | 本体进入引擎的唯一方式：全量期望态 + 服务端权威 | [60](60-evolution.md) §2 |
| 变更三档 | 自动 / 数据校验 / 拒绝——本体变更分类学 | [60](60-evolution.md) §4 |
| 本体修订号（revision） | 服务端单调递增整数，成功收敛 +1、no-op 不涨 | [60](60-evolution.md) §2–3 |
| 接入端点 | 管理面批量写入口：引擎通道、服务账号、不经动作 | [70](70-operations.md) §2 |
| 导入批次 | 每接入请求一条的审计条目类型，不记逐对象明细 | [70](70-operations.md) §4 |
| 外部同步器 | 模式级：外部进程 + 接入端点写入 + 水位线轮询读 | [70](70-operations.md) §5 |
| 线上面 | REST 通用端点 + TS SDK，端点集对任意本体不变 | [30](30-api.md) §1 |
| 管理面 | `/v1/admin/*` 单伞九组；ingest 服务账号例外余仅超管 | [30](30-api.md) §4 |
| 错误信封 | `{error: {code, message, details?}}`；零行 = 200 | [30](30-api.md) §6 |

- 术语表与仓库根 [CONTEXT.md](../../CONTEXT.md) 同源（撰写期工作术语表）；冲突以本规格为准。
- 新术语入规格时**应当**同步更新本章速览（增条目即时更新，勿批量）。

---
*决策史：地图 #1 根决策与 Out of scope、ADR-0006（技术栈）、ADR-0008（REST 修订）、#13（深规格验收线）、#14（矩阵判据）。*
