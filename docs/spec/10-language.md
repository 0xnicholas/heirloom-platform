# 本体语言

> **范围**：结构类型与对象类型、属性九类标量与就地约束、数组语义、一等链接与基数、业务键、命名元数据、DSL 外形。
> **不含**：演化语义（[60](60-evolution.md)）；动作与参数拼写细节（[20](20-actions.md)）；存储物理映射（[40](40-engine.md)）。
> **素材**：ADR-0001（核心语义）、ADR-0002（约束的物理承载）、[#12 决议](https://github.com/0xnicholas/heirloom-pro/issues/12)（DSL 外形八项）；示例本体冻结自 [#12 原型](https://github.com/0xnicholas/heirloom-pro/blob/prototype/ts-dsl-shape/prototype/ts-dsl-shape/ontology.ts)（HR/项目域）。
> **待落位**：无。
> **验收线**：深规格（[#13](https://github.com/0xnicholas/heirloom-pro/issues/13)：逐条规范性陈述、示例内嵌、总表归 [90](90-appendix.md)）

## 1. 定位

本体语言是数据支柱的地基：平台用户在**运行时**用 TS DSL 定义本体（类型/属性/链接/动作/函数），经 CLI 物化为定义 JSON 推送引擎（见 [60](60-evolution.md)）。代码即配置：无声明式规则层、无 XML/YAML schema、无可视化编辑面（平台 UI → v2）。

规范性陈述（总）：

- 本体定义**必须**以 TS DSL 源文件形式存在于 Git 仓库；引擎**必须**只接受经 [60 章](60-evolution.md) push 流程收敛的定义 JSON。
- 每个类型、属性、链接、动作、函数**必须**携带命名元数据：`apiName`（代码引用名）+ `displayName`（人类可读名）+ `description`（可选）。
- `apiName` **必须**为 `kebab-case`（对象/动作/函数）或 `camelCase`（属性/链接/struct）；创建后改名 = 删 + 加（见 [60](60-evolution.md) 拒绝档）。
- `status` 生命周期字段（`experimental` / `active` / `deprecated`）为纯元数据，语义归 [60 章](60-evolution.md)。

## 2. 两级类型分立

| | object type（对象类型） | struct（结构类型） |
|---|---|---|
| 身份 | 有：服务端 UUID 主键 | 无 |
| 链接 | 可被链接、可声明链接 | 不得参与链接 |
| 查询 | 可独立查询/过滤/分页 | 不可独立查询，随宿主取回 |
| 授权 | 读授权的目标单位 | 无独立权限，随宿主判定 |
| 复用 | 不复用（每型独立） | **可**复用于多个宿主、可嵌套 |
| 删除 | 按删除语义（[40](40-engine.md)） | 随宿主删除 |

- struct 是无身份的嵌入值（如 `Address`、`Money`）；**必须**经 `structType({...})` 声明后以 `p.struct(Name)` 嵌入属性位。
- struct 复用是 v1 唯一的形状共享机制：**无继承、无接口、无 mixin**（→ v2，[90](90-appendix.md)）。跨类型行为差异用各自的动作表达。
- struct 嵌套**不得**超过两层（struct 内嵌 struct 一层）；深层数据**应当**拉平为属性或升格为对象类型。

## 3. 属性与九类标量

属性声明 = 类型化构建器 + 就地约束修饰符（链式，见 §6 DSL 外形）。属性**默认可选**；`required` 显式声明（演化友好：后加可选属性不破存量数据）。

| 标量 | TS/JSON 值域 | 线上编码 | 约束适配 |
|---|---|---|---|
| `string` | UTF-8 | JSON string | `length` / `regex` / `unique` |
| `boolean` | true / false | JSON boolean | — |
| `integer` | ±2^53（JSON 安全区间） | JSON number | `range` / `unique` |
| `float` | 双精度近似 | JSON number | `range` / `unique` |
| `decimal` | 任意精度十进制 | **JSON 字符串**（规避浮点精度坑） | `range` / `unique` |
| `date` | 公历日 | ISO 8601 字符串 `yyyy-mm-dd` | — |
| `datetime` | 时间点（UTC 存储） | ISO 8601 字符串 + 时区偏移 | — |
| `enum` | 封闭值集 | JSON string（值本身） | 值集不可空；加值=自动档、有引用删值=拒绝档（[60](60-evolution.md)） |
| `json` | 任意 JSON（逃生舱） | 原样 | 无约束、无索引、无过滤算子（`eq` 全值比较除外） |

规范性陈述：

- `decimal` 值在 API 与 SDK 全链路**必须**以 JSON 字符串编码；SDK **应当**提供解析辅助（如 `Decimal` 包装）。引擎校验其十进制文法。
- `integer` 超出 ±2^53 的值**必须**被 push 拒绝（语言层不提供 bigint 标量；需要精确大数用 `decimal`）。
- `json` 标量是逃生舱：**不得**用它承载结构性领域数据（引擎不对 json 内部做约束/过滤/索引）；结构性数据**应当**建 struct 或独立属性。
- **动态默认值不存在于属性层**：属性默认值**必须**为静态字面量；依赖上下文的默认（now/当前用户）归动作参数（[20](20-actions.md)）。
- 跨字段组合校验不存在于属性层：**必须**写在动作 `execute` 内（[20](20-actions.md)）。

### 3.1 数组属性

- 元素限值类型：`scalar[]` / `enum[]` / `struct[]`。**对象引用不得作为属性值**——引用一律走链接（§4）。
- 数组默认**保序、允许重复**；声明 `.unique()` 转集合语义（保序去重）。
- 数组元素的约束按元素类型适配（如 `string[].unique()` = 元素集合语义；`length` 作用于整个数组长度）。

### 3.2 业务键

- 业务键 = 属性上的 `unique` 约束（如工号 `employeeNo`）；**不是**主键，业务键演化不动主键。
- `unique` 冲突在写事务提交时检测 → 409 语义（线上编码见 [30](30-api.md)）。
- 每类型可以有零或多个 `unique` 属性；复合业务键 v1 不提供（→ [90](90-appendix.md)）。

## 4. 一等链接

链接是对象间引用的一等声明，**独立于属性**（不存在「外键属性」）。

| 维度 | 取值 | 语义 |
|---|---|---|
| 基数 | `1:1` / `1:N` / `M:N` | 三档封闭；声明方视角选助手（§6） |
| 方向 | 单侧声明，双侧游走 | 正向命名 + 反向命名（可派生） |
| required | 可选 | 声明后：写事务提交时**必须**已链接，否则整事务回滚 |
| 载荷 | **无** | 链接不携带数据 |

- **链接载荷升级模式**：关系需要挂数据（角色/日期/审批状态）时，**必须**建模为中间对象类型 + 两条 1:N 链接（示例本体的 `Membership`）。v1 无链接属性、无 n 元关系（→ v2）。
- **反向名派生规则**（normative）：省略 `reverse` 时，派生为**声明方对象类型的 `apiName` 原样**（不加复数）。若目标类型一侧因此出现两个同名反向名（同型双链接省略 reverse），push **必须**拒绝并要求相关链接显式命名。
- 遍历：正向 `linked(Type, obj, 'linkName')` 带类型；反向 `backlinks(Type, obj, 'reverseName')` 运行时校验、弱类型（全双向静态类型推断 → v2）。
- 链接的物理映射（外键列 vs 链接表）、删除时的级联行为归 [40 章](40-engine.md)。

## 5. 身份

- 对象 ID = 服务端生成的 **UUIDv7**（应用层生成、事务开始前已存在——动作可同事务引用新建对象）。语言层不声明主键。
- ID 创建后**不得**变更；对外不透明（无 IRI / 命名空间泄漏；普通 JSON + UUID 字符串）。

## 6. DSL 外形（八项，normative）

1. **属性声明 = 链式修饰符**（zod/drizzle 风）：`p.string().required().unique().length(1, 80)`；类型推断走幻影类型参数（值类型 × required × 默认值三轴）。被否：选项对象。
2. **链接声明 = 四基数助手**：`link.oneToOne / oneToMany / manyToOne / manyToMany`，从**声明方视角**命名（`Department.employees = link.oneToMany(() => Employee, ...)`）。
3. **链接目标一律 thunk**：`() => Employee`（前向引用与自引用皆为单文件本体常态；一致性优先）。被否：非循环直传（重排声明顺序改变合法性）；字符串目标（失类型检查）。
4. **自引用 thunk 标注 `(): any => Employee`**：TS 循环初始化硬限制（drizzle `(): AnyPgColumn` 同款）——已知限制见 [90](90-appendix.md)。
5. **反向名**：显式 `reverse: '...'` 或按 §4 派生规则省略。
6. **遍历不对称（v1）**：正向有类型 / 反向弱类型。
7. **编辑操作四参形态**：`ctx.link(Type, obj, 'linkName', target)`——类型打头，与正向遍历对称；同型双链接时链接名是唯一键。
8. **对象引用参数**：`p.ref(() => T)`——传 UUID，`execute` 前注入完整对象（见 [20](20-actions.md) §3）。

## 7. 示例（冻结本体摘录）

```ts
export const Address = structType({
  apiName: 'address',
  displayName: '地址',
  properties: {
    street: p.string().required(),
    city: p.string().required(),
    zip: p.string().length(5, 10),
  },
});

export const Employee = objectType({
  apiName: 'employee',
  displayName: '员工',
  properties: {
    employeeNo: p.string().required().unique().displayName('工号'),  // 业务键
    status: p.enum(['active', 'on-leave', 'offboarded']).default('active'),
    salary: p.decimal().range(0),          // JSON 字符串编码
    certifications: p.string().array().unique(),  // 数组 + 集合语义
    address: p.struct(Address),            // struct 嵌入
    metadata: p.json(),                    // 逃生舱
  },
  links: {
    mentor: link.oneToOne((): any => Employee, { reverse: 'mentee' }),  // 1:1 自引用
    skills: link.manyToMany(() => Skill),  // 反向名派生为 'employee'（原样）
  },
});

// 载荷升级：Membership = 中间对象 + 两条 required 1:N
export const Membership = objectType({
  apiName: 'membership',
  properties: { role: p.enum(['lead', 'contributor', 'reviewer']).required(), joinedAt: p.date().required() },
  links: {
    employee: link.manyToOne(() => Employee, { required: true }),
    project: link.manyToOne(() => Project, { required: true }),
  },
});
```

完整示例本体（Department/Skill/Project/动作/函数全量）见冻结归档；验收场景（[80](80-scenarios.md)）以它跑通全部构造。

## 8. 已知限制与 v2（详见 [90](90-appendix.md)）

无继承/接口/n 元关系/链接属性；无 byte/short/vector/uuid 标量；无复合业务键；反向遍历弱类型；自引用 `(): any` 毛边；`json` 内部零约束零索引。

---
*决策史：ADR-0001（八决策）、ADR-0002（约束物理承载）、#12（DSL 外形八项）。*
