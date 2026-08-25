# 技术栈与打包

> **范围**：技术栈总表与选型依据（渲染层/图谱库/宿主/分发）、本地 server 职责与 API 最小面、网络与安全边界、运行前置、与平台包的依赖关系、性能预算。
> **不含**：工作簿数据模型（[60](60-data.md)）；求值子进程协议（[40](40-eval-channel.md)）。
> **素材**：[#23 决议](https://github.com/0xnicholas/heirloom-pro/issues/23) + #18 T1/T3（排版/diff 归 [30](30-drafting.md)）；ADR-0006（TS 生态背书）。
> **验收线**：深规格工具版（#22：错误/边界清单）

## 1. 技术栈总表（normative）

| 层 | 选型 | 依据 |
|---|---|---|
| UI 框架 | React + TSX | 生态与 TSX 表达力；ADR-0006 TS 背书延伸 |
| 图谱 | reactflow（MIT） | pan/zoom/drag/select 现成；自定义 SVG 节点（C 变体已验证形状） |
| 排版 | 模板 + Prettier | [30](30-drafting.md) §3 |
| diff | jsdiff | [30](30-drafting.md) §9 |
| 求值 | bun 子进程（node+tsx 兜底） | [40](40-eval-channel.md) |
| 宿主 | bun 本地 server + 浏览器标签页 | §3 |
| 分发 | npm 包，`bunx heirloom-workbench` | §4 |

**被否**（#23 存档）：Svelte（丢 reactflow 生态红利，两套心智无增益）；纯手写 SVG（pan/zoom/drag/命中全套自造，数周工期）；Tauri（Rust 工具链 + 系统 webview 方差，顾问工具过重）；Electron（100MB 壳体量）；纯静态/PWA（**spawn 不了子进程**——决定性，求值通道需要）。

## 2. 渲染层

- reactflow 节点 = **自定义 SVG 组件**（非默认卡片）：对象类型圆角矩形、草稿虚线绿框（[20](20-interface.md) §3 图形语义）；边 = 链接 + 基数标注 + required 标记。
- 布局 v1 **无自动排布**（力导向/自动分层 → v2 再议）：节点位置手拖、持久化进工作簿（[60](60-data.md) §4）——摆放即工作坊信息。
- reactflow 版本随实现锁定；**应当**跟随主流稳定版。

## 3. 宿主：bun 本地 server + 浏览器

```
bunx heirloom-workbench <repo路径>
  → 起 localhost server（仅 127.0.0.1）→ 自动开浏览器标签页
```

- server 绑定**必须**仅 `127.0.0.1`（零网络根决策；**不得**绑 0.0.0.0）；**无认证**（本地单机；localhost 即边界）。
- server 职责（normative 最小面）：

| 职责 | 说明 |
|---|---|
| 静态 UI 资源 | 浏览器加载的工具前端 |
| 工作簿读写 | `.heirloom-workbench.json` 的唯一写者（[60](60-data.md) §2） |
| extractor 代理 | spawn 子进程、协议解析（[40](40-eval-channel.md) §2） |
| 草稿生成 | def 组装 → Prettier（`resolveConfig` 贴仓库）→ 写 untracked 文件（[30](30-drafting.md) §3） |
| diff 计算 | jsdiff 双出口（[30](30-drafting.md) §9） |

- 文件系统访问（Prettier 配置、草稿写盘、工作簿）全部在 server 进程——浏览器端零 fs。Prettier `resolveConfig`（贴仓库自身 `.prettierrc`）**必须**在 server 侧执行。
- server 无状态（工作簿即全部状态）；**不得**引入数据库。

## 4. 分发：npm 包 + bunx

- npm 包名 `heirloom-workbench`；`bunx heirloom-workbench <repo>` 为唯一启动形态。
- **依赖平台 CLI 包以取 extractor**（#23）：工具包**不得**自带 extractor 副本（同源约束，[40](40-eval-channel.md) §1）——peer/直接依赖平台包，锁「支持的版本区间」（区间策略随实现定；平台 DSL 词汇变化时生成器封闭词汇**必须**同步——[30](30-drafting.md) §3 快照测试是联动验收手段）。

## 5. 网络与安全边界（错误/边界清单）

| 边界 | 行为 |
|---|---|
| 非 127.0.0.1 访问（他机/0.0.0.0） | 不存在——绑定即拒绝面 |
| 浏览器直开静态文件（无 server） | 不支持——求值/生成/工作簿全断（PWA 被否的决定性理由） |
| 端口占用 | 报错 + 下一个可用端口重试（**应当**）；不得静默换端口不告知 |
| `<repo>` 非目录/无读写权限 | 启动即报错，指引明确 |

## 6. 运行前置（文档化，进包 README）

| 前置 | 必需性 |
|---|---|
| bun | **文档化前置**（首选运行时 + 宿主） |
| node + tsx | 兜底组合（无 bun 时，[40](40-eval-channel.md) §3） |
| 平台 CLI 包 | npm 依赖自动安装（§4） |
| 浏览器 | 常青浏览器最近两版（Chrome/Edge/Safari/Firefox；**应当**，不做旧浏览器兼容） |
| Git | 贴回指引面向 git 工作流（工具自身不调 git——[30](30-drafting.md) §8） |

## 7. 性能预算（normative 目标值）

| 项 | 预算 | 依据 |
|---|---|---|
| extractor 全量求值 | ~60ms 量级 | 实证基线（归档 demo 21 步） |
| watch 重求值节流 | 100ms 防抖 + 60ms 求值 → 用户无感 | [40](40-eval-channel.md) §5 |
| UI 交互响应 | <100ms（点选/抽屉/灯刷新） | 投影场景不耐顿 |
| 图谱规模 | 百节点级流畅（reactflow 标称千节点；工具目标百节点 + [20](20-interface.md) §8 软上限建议） | 工作坊实际规模 |

## 8. 已知限制与 v2（详见 [90](90-appendix.md)）

无自动排布；无离线安装包（全链 npm）；浏览器兼容面未实测；平台包版本区间策略实现期定；单仓库单实例（多仓库多标签未定义）。

---
*决策史：#23（两决议 + 四被否形态）、#18 T2（spawn 决定性依据）、ADR-0006（TS 背书）。*
