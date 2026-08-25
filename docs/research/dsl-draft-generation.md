# 调研：DSL 草稿生成与求值嵌入技术

- **票**：[#18 调研：DSL 草稿生成与求值嵌入技术](https://github.com/0xnicholas/heirloom-pro/issues/18)
- **父图**：[#16 工作台图：顾问建模工作台的规格之路](https://github.com/0xnicholas/heirloom-pro/issues/16)
- **服务对象**：[#20 生成与预检语义](https://github.com/0xnicholas/heirloom-pro/issues/20)（直接）；[#21 工作台界面外形原型](https://github.com/0xnicholas/heirloom-pro/issues/21)（间接）
- **已锁定前提**（图 #16 Notes）：本地单机、工作坊投影场景；读侧 = 求值本体 TS 模块提取注册表（与 heirloom CLI 同源机制，ADR-0007 决议 1）；写侧 = **只生成新增 objectType/action/queryFn 块的 DSL 草稿 + diff 预览**，既有源码零改写。
- **证据标注**：【实证·文档】= 官方文档/发布说明原文；【实证·本地】= 本地复现/测量（bun 1.1.42、node v26.2.0、归档原型分支 `prototype/ts-dsl-shape` worktree 复跑）；【推断】= 由实证推导、未实测。

## TL;DR 决策点速览

| # | 决策点 | 推荐 | 一句话理由 |
|---|--------|------|-----------|
| T1 | 新块 DSL 草稿的生成与排版 | **模板字符串封闭词汇生成器 + Prettier 终排版**（否 ts-morph / 裸 TS printer） | 写侧只**生成**不**编辑**：AST 库的核心价值（操纵既有代码）用不上，而 execute 体是任意代码本就只能字符串化；Prettier 保证终排版稳定且尊重仓库自身 `.prettirrc` |
| T2 | 本体模块求值嵌入宿主 | **bun 子进程 + stdout JSON 协议**（node + `--import=tsx` 兜底），extractor 入口与 CLI 同一可执行 | Node 原生 type stripping 对归档 DSL 的两处语法直接报错（实证）；子进程隔离用户代码崩溃/副作用、watch=重 spawn（~60ms 实测）、无 ESM 缓存与注册表单例残留问题 |
| T3 | 草稿 vs 仓库现状的 diff 呈现 | **jsdiff**：`structuredPatch`（UI 渲染）+ `createTwoFilesPatch`（unified 文本） | 写侧纯追加 → 行级 unified diff 即正确粒度；块级对齐无场景（无移动/重命名）；Myers 算法、纯内存、不依赖 git 工作树 |

---

## 1. 技术点①：TS 代码块生成的稳定排版

### 1.1 一手事实

**DSL 词汇是封闭集，草稿=已知形状的序列化**
- #12 八项定稿后，本体源码的外形词汇全部锁定：`objectType/structType` 块、`link.oneToOne/oneToMany/manyToOne/manyToMany` 四助手、`p.*().required().unique().length()` 链、`action/queryFn` 块、thunk 目标、四参 `ctx.link`（[归档原型 ontology.ts](https://github.com/0xnicholas/heirloom-pro/tree/prototype/ts-dsl-shape/prototype/ts-dsl-shape)，【实证·本地】）。60~200 行的草稿块 = 这些固定形状的参数化组合。
- **execute 函数体是任意 TS 代码**（ADR-0003 决策 1：函数式动作）——它没有「结构化中间表示」，进入生成流程的天然形态就是字符串。

**TypeScript compiler API（裸 printer/factory 路线）**
- 官方 wiki 给出 factory + printer 生成代码的标准路径：`ts.factory.createFunctionDeclaration(...)` 构造 AST，`ts.createPrinter({newLine}).printNode(EmitHint.Unspecified, node, sourceFile)` 输出字符串（[Using-the-Compiler-API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)，【实证·文档】）。同页示例：一个 4 行的 factorial 函数 ≈ 15 行 factory 代码——构造式冗长可见一斑。
- ⚠ 同页顶部警示：**「The contents of this page currently describe TypeScript 6.0 and earlier. TypeScript 7.1 will have a completely different API.」**（【实证·文档】）——TS 原生 compiler API（Go 移植，corsa）将换 API；裸依赖它等于把排版层押在即将重构的接口上。

**ts-morph（包装路线）**
- 自述定位：**「This library wraps the TypeScript compiler API so it's simple」**——核心卖点是 Setup/Navigation/**Manipulation**（[ts-morph.com](https://ts-morph.com/)，【实证·文档】）。
- 其操纵 API 本就以**字符串插入**为主：`node.replaceWithText("MyReference")`、`sourceFile.addStatements("console.log(5);")`、code writer 写块（[Manipulation 文档](https://ts-morph.com/manipulation)，【实证·文档】）——即便走 ts-morph，execute 体与大部分内容仍以字符串进入。
- 文档自认不全：**「some existing features don't have documentation」**（同站，【实证·文档】）；且作为 compiler API 的包装层，继承上条的 7.1 重构耦合（【推断】：ts-morph 对新 compiler 的适配周期额外引入风险）。

**Prettier（程序化格式化）**
- `prettier.format(source, options)`：`options.parser` 指定语言（TS 用 `"typescript"`），或给 `filepath` 按扩展名推断；**`prettier.resolveConfig(filePath)` 会向上搜索并应用本体仓库自己的 `.prettierrc`**（[Prettier API 文档](https://prettier.io/docs/api)，【实证·文档】）——生成的草稿自动贴合目标仓库的既有风格。
- 官方 API 全异步；确需同步有 `@prettier/sync`（同页，【实证·文档】）。
- 同页警告不要用「parse→改 AST→print」做 codemod（位置信息失同步）；对**全新生成**的文本做 format 无此问题（【推断】）。

### 1.2 推荐与被否

**推荐：模板字符串封闭词汇生成器 + Prettier 终排版。**

- 生成器输入 = 结构化 def（与定义 JSON 同构，读侧注册表的同一形状），输出 = 平铺 DSL 文本；链式修饰符**不手工断行**——模板层发单行链，换行交给 Prettier 按 `printWidth` 决定。格式稳定性的来源恰是「不自己管中间形态，终态只认 Prettier」。
- 词汇封闭 → 生成器可穷举快照测试（每个构造 × 参数组合的输出锁进测试），排版回归零逃逸（【推断·工程判断】）。
- 尊重仓库 `.prettierrc`：客户仓库用什么缩进/引号，草稿就长什么样（实证见上）。

**被否：ts-morph / 裸 compiler printer 的 AST 构造路线。**
- 本任务是**从零生成**，不是编辑既有代码——AST 操纵（replace/insert/rename，ts-morph 的核心价值）无用武之地；而最难的部分（execute 体）反正退化为字符串（ts-morph 的 `addStatements` 本就收字符串，实证见上）。
- factory 冗长（15:4 实证见上）+ TS 7.1 API 更换的版本耦合（实证警示见上）+ ts-morph 文档不全。
- 若未来出现「改写既有块」需求（当前图 Notes 显式排除：既有源码零改写），ts-morph 才重新入场——留作重访条件写进 #20。

---

## 2. 技术点②：本体模块求值嵌入宿主

### 2.1 一手事实

**注册表 = 模块级副作用单例（求值即提取，也即同进程重求值的陷阱）**
- 归档 `dsl.ts`：`export const registry = { structs: [], objectTypes: [], actions: [], queryFns: [] }`（dsl.ts:279 起），`objectType()` 等工厂在调用时 push 进 registry（【实证·本地】）。「提取注册表」= 执行模块然后读这个单例。同进程内**重复求值**必须用 query-string 绕 ESM 缓存，且单例里残留上次的注册项——语义脏（【推断】：机制必然，未实测）。

**Node 原生 type stripping 跑不了当前 DSL（两处硬伤，均实证）**
- 参数属性报错：官方文档明确列 parameter properties 为 type stripping 不支持项，触发 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（[Node TypeScript 文档](https://nodejs.org/api/typescript.html)，【实证·文档】）。本地复现：v26.2.0 下 `class A { constructor(public x: number) {} }` 直接抛错，去掉 `public` 即可运行（【实证·本地】）。归档 `PropBuilder` 构造器恰是 `constructor(public kind, public opts)`（dsl.ts:45-48）。
- 相对导入必须带扩展名：官方「file extensions are mandatory in import statements」；本地复现：`node demo.ts` 死于 `ERR_MODULE_NOT_FOUND`——原型 `import ... from './dsl'` 无扩展（【实证·文档+本地】）。
- Node 官方对「full TypeScript support」的建议就是挂第三方加载器：**「use a third-party package … These instructions use `tsx` … `node --import=tsx your-file.ts`」**（同页，【实证·文档】）。type stripping 默认开启始于 v23.6.0，`tsconfig.json` 被忽略（paths 别名报错）、`.tsx` 不支持（同页，【实证·文档】）。

**bun 原生直跑当前 DSL：全绿（决定性实证）**
- 本地 worktree 复跑归档 demo：`bun run demo.ts` 21 步场景全部通过、审计日志正常输出，全程 **~60ms**（【实证·本地】）。bun 冷启动 ~20ms（热）首启 ~190ms（【实证·本地】测量）；对照 node 冷启动 ~85ms（【实证·本地】）。Bun 官方支持 `.ts` 直跑与无扩展解析（[Bun TS 文档](https://bun.sh/docs/runtime/typescript)，【实证·文档】——页面只取到部分内容，「原生跑 TS」以本地复跑为权威佐证）。

### 2.2 推荐与被否

**推荐：bun 子进程 + stdout JSON 协议；extractor 入口脚本与 CLI 同一可执行。**

- 协议：宿主 spawn `bun run heirloom-extract.ts <ontologyEntry>` → 子进程求值本体模块、把 registry 物化为定义 JSON 打到 stdout、非零退出码 + stderr 带堆栈表示模块错误（与 ADR-0007 决策 1 的 CLI 求值步**字面同一步**——同源是构造性保证：工作台与 `heirloom ontology apply` 调同一个入口，不是两份实现各自模仿）。
- watch = 宿主文件监听（本体目录）→ 重新 spawn：60ms 级全量重求值（实证见上），无需增量编译状态、无需绕缓存；用户本体代码的崩溃与副作用（top-level await 卡死、`process.exit`、全局污染、环境变量读取）被进程边界完整隔离——工作坊投影场景下 UI 进程永不被客户代码带崩。
- 兜底：目标机无 bun 时以 `node --import=tsx` 跑同一 extractor（Node 官方背书的 full-support 路线，实证见上）；协议不变只换运行时。规格只需文档化两个运行时的先决条件。

**被否：进程内动态 import。**
- Node 原生路径被两处实证硬伤堵死（参数属性 + 无扩展导入）；加载器路线（tsx/jiti 进宿主）把转译管线与任意用户代码拉进 UI 进程——崩溃不隔离、watch 需 query-string 绕 ESM 缓存且 registry 模块级单例跨次求值残留（事实见 2.1 首条），求值语义从此与 CLI 分叉。
- 「读服务器 meta/ontology」已被图 #16 Notes 锁死出局（本地零依赖前提），不再列为候选。

---

## 3. 技术点③：新块草稿 vs 仓库现状的 diff 呈现

### 3.1 一手事实（jsdiff，README 全文核验）

- 算法：基于 **Myers 1986《An O(ND) Difference Algorithm and its Variations》**（[jsdiff README](https://github.com/kpdecker/jsdiff)，【实证·文档】——源码克隆核验）。
- diff 系：`diffLines(old, new, {ignoreWhitespace, newlineIsToken, ...})` 逐行 token；`diffArrays` 支持自定义比较器（可按空行切块做**块级** diff）；`diffJson` 按字母序序列化后逐行（同页，【实证·文档】）。
- patch 系：`createPatch` / `createTwoFilesPatch` = diffLines → **unified diff 格式**文本；`structuredPatch` 返回 hunk 对象数组（「suitable for further processing」——UI 渲染的机器面）；`formatPatch` 可输出 Git 风格头；`applyPatch(source, patch, {fuzzFactor})` 可套用并容错定位、失败返回 `false`；`parsePatch` 反解析（同页，【实证·文档】）。
- 分词可定制：`diffWords` 可接 `Intl.Segmenter`（对中文词级更准）（同页，【实证·文档】——与代码 diff 无关，列此说明库的 tokenizer 扩展点）。

### 3.2 推荐与被否

**推荐：jsdiff，双出口。**
- **UI 渲染走 `structuredPatch`**（hunk 对象 → 并排/内联视图、增删行统计，喂 #21 的草稿预览屏）；**文本出口走 `createTwoFilesPatch`**（复制/导出 unified diff，客户可贴进 PR 描述）。
- 粒度定行级：写侧纯追加（proposed = 现文件 + 追加块，或全新文件），无移动/无重命名——unified 行级 diff 语义恰好；**块级对齐（diffArrays 按空行切块）不进 v1**：没有它能服务的场景，若 #21 界面原型决定要「块卡片 + 块内 diff」的视觉分层再启用（【推断】）。
- 输入纯内存字符串：草稿常是未落盘的缓冲区，不依赖 git 工作树状态。

**被否：**
- **diff-match-patch**：字符级语义 diff，为富文本模糊匹配而生，无 unified patch 输出——粒度与出口都不对位。
- **外部 `git diff`**：依赖 git CLI 存在 + 工作树干净，与「缓冲区 vs 落盘文件」的对比场景不匹配。
- **自研 LCS**：Myers 已被 jsdiff 完整实现且 API 对位，无再造理由。

---

## 4. 对 #20（生成与预检语义）的喂给

1. **生成器形态**：结构化 def（与定义 JSON 同构）→ 平铺 DSL 文本模板 → `prettier.format({parser:'typescript', ...resolveConfig(repoPath)})`。快照测试穷举封闭词汇锁定输出。链式断行不进模板层，终态只认 Prettier。
2. **重访条件（写进 #20 决议）**：若未来图重开「改写既有块」（当前显式排除），排版层升级 ts-morph——届时它是正确工具。
3. **预检的求值通道**：三档矩阵预检需要「注册表现状」——用 T2 的 extractor 子进程取（与 CLI 同源）；「提议定义」在宿主内存中以同构 def 表达，diff 在 def 层做分类模拟（分类学规则来自 ADR-0007），**不需要**为预检单独跑引擎。
4. **diff 出口**：`structuredPatch`（UI）+ `createTwoFilesPatch`（文本）双出口；行级粒度；块级留作 #21 视觉分层的可选增强。
5. **运行时先决条件**：bun（首选）或 node+tsx（兜底）二选一安装，进工具规格的「环境要求」节；extractor 入口脚本命名与分发方式归 #20/#22 的规格细节。

## 5. 逐源清单

| 来源 | 用途 | 标注 |
|---|---|---|
| [Node.js TypeScript 模块文档](https://nodejs.org/api/typescript.html) | type stripping 边界：参数属性/扩展名导入/tsx 官方建议/版本时间线 | 实证·文档 |
| [Prettier API 文档](https://prettier.io/docs/api) | format/resolveConfig/@prettier/sync/codemod 警告 | 实证·文档 |
| [ts-morph.com](https://ts-morph.com/) 及 [Manipulation 页](https://ts-morph.com/manipulation) | 定位自述、字符串插入 API、文档不全自认 | 实证·文档 |
| [TypeScript compiler API wiki](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) | factory+printer 路径、冗长度、**TS 7.1 API 更换警示** | 实证·文档 |
| [jsdiff README（源码克隆核验）](https://github.com/kpdecker/jsdiff) | Myers 算法、diff/patch 全 API、structuredPatch/applyPatch 语义 | 实证·文档 |
| [Bun TypeScript 文档](https://bun.sh/docs/runtime/typescript) | .ts 直跑与解析支持（部分页面；权威佐证为本地复跑） | 实证·文档（部分）+实证·本地 |
| 本地测量/复现（bun 1.1.42、node v26.2.0、`prototype/ts-dsl-shape` worktree） | bun 直跑归档 DSL 全绿 ~60ms；node 两处报错复现；冷启动量级 | 实证·本地 |
