# 动作

> **范围**：函数式动作定义结构、参数模型、校验契约、五编辑操作、活事务、并发与重试、权限边界、效应边界、审计日志、只读函数（queryFn）。
> **不含**：HTTP 线上编码（[30](30-api.md)）；权限模型本体（[50](50-security.md)）；存储事务原语（[40](40-engine.md)）。
> **素材**：ADR-0003（动作语义）、ADR-0002（单事务原语/UUIDv7 预生成）、ADR-0004（PermissionDenied/白名单两层）、ADR-0005（导入批次条目）；示例冻结自 [#12 原型](https://github.com/0xnicholas/heirloom-pro/blob/prototype/ts-dsl-shape/prototype/ts-dsl-shape/ontology.ts)。
> **待落位**：无。
> **验收线**：深规格（[#13](https://github.com/0xnicholas/heirloom-pro/issues/13)：逐条规范性陈述、示例内嵌、总表归 [90](90-appendix.md)）

## 1. 定位

动作（Action）是**语义层的唯一写路径**：显式声明的领域动词 = 命名 + 类型化参数 + 单事务执行的 TS 函数体（`execute`），服务端进程内执行。权限与审计只挂在动作边界；不经动作的对象写入不存在于语义层（引擎写入通道的管理面暴露 = 接入端点，见 [70](70-operations.md)——授权、审计语义独立）。

- v1 **仅函数式动作**：无声明式规则分类学（create/modify/upsert 规则配置）、无 submission criteria 层（单事务下隔离价值消失；代码即配置）。
- 动作 = 一个事务里跑的函数（心智模型）。

## 2. 定义结构

```ts
export const hireEmployee = action({
  apiName: 'hire-employee',        // kebab-case；invoke 端点即用此名（30 章）
  displayName: '录用员工',
  params: { /* §3 */ },
  execute: (ctx, params) => { /* §5–§6；返回值 = 动作结果对象 */ },
});
```

## 3. 参数模型

| 参数类型 | 声明 | 输入 | 引擎行为 |
|---|---|---|---|
| 九类标量（含数组变体） | `p.string().required()` 等 | JSON 值 | 逐参数类型/约束校验 |
| struct | `p.struct(Address)` | JSON 对象 | 形状校验（struct 定义） |
| **对象引用** | `p.ref(() => Department).required()` | **UUID** | `execute` 前预取并**注入完整对象**；不存在 → 结构化校验失败（422 语义） |

- 默认值：静态字面量或动态函数 `(ctx) => value`（如 `hiredAt: p.date().default((ctx) => ctx.today)`）。这是属性层「动态默认归动作层」的兑现位。
- 无 hidden 参数、无对象集参数（集合输入 → 查询/函数层，[30](30-api.md)）。
- `ctx`（执行上下文）**必须**至少暴露：`ctx.userId`、`ctx.groups`、`ctx.today`、`ctx.now`（权限判定与动态默认的依据；详见 [50](50-security.md)）。

## 4. 校验契约

- **无声明式 criteria 层**：全部动态校验在 `execute` 内做，不满足时抛结构化异常 `ValidationFailed`（逐字段消息：`throw new ValidationFailed({ salary: '…' })`）。
- 语义契约（承 Palantir）：校验结果作为响应的一部分**逐参数可区分**；HTTP 状态码映射（422）与错误信封见 [30](30-api.md)。
- user 类条件（「当前用户是否允许对此行操作」）**不得**用 `ValidationFailed`——用 `PermissionDenied`（§7）。
- 注入失败（ref 参数对象不存在）= 参数校验范畴，非运行时错误。

## 5. 编辑操作（五件套）

| 操作 | 签名形态 | 语义 |
|---|---|---|
| create | `ctx.create(Type, props)` | 建对象（UUIDv7 事务前预生成）；返回完整对象（含 `id`） |
| modify | `ctx.modify(Type, obj, patch, opts?)` | 部分更新；`opts.expectedUpdatedAt` 启用乐观锁（§8） |
| delete | `ctx.delete(obj)` | 删除；required 链接阻止 / optional 自动摘链（[40](40-engine.md)） |
| link | `ctx.link(Type, obj, 'linkName', target)` | 建链接；1:N 下 link 即移动（旧侧自动摘除） |
| unlink | `ctx.unlink(Type, obj, 'linkName', target)` | 摘链接 |

- **全基数统一**：link/unlink 对 1:1 / 1:N / M:N 语义一致，存储层差异（列更新 vs 链接表行）对动作作者不可见。
- **无 upsert**：`unique` 冲突 → 409 语义；需要时显式「查-建」两步（RYW 保证可行，见 §6 示例 `grantSkill`）。

## 6. 活事务

`execute` 全程处于**同一 DB 事务**：

- **read-your-writes**：事务内读得到本事务已写；
- **同事务引用**：可引用本事务新建对象（UUIDv7 事务前预生成）；
- **顺序写后写胜出**：无编辑折叠器、无禁止清单（delete-before-add / double-create 等禁令不设——单事务顺序 SQL + Postgres 约束即真相）；
- 正常返回即 **COMMIT**；任何抛错（含 `ValidationFailed` / `PermissionDenied`）即 **ROLLBACK**——回滚 = 无事发生（不落审计，[50](50-security.md) 安全日志照记授权拒绝）；
- 动作事务**必须**有超时上限（默认 30s、可配置——规格只锁「存在上限」），超时即回滚（防长事务持锁）。

```ts
// 无 upsert 的「查-建」两步 + RYW + 同事务引用
const skill = ctx.all(Skill).find((s) => s.name === skillName) ?? ctx.create(Skill, { name: skillName });
ctx.link(Employee, employee, 'skills', skill);
```

## 7. 权限边界（两层）

| 层 | 判定 | 拒绝形态 | 记录 |
|---|---|---|---|
| 引擎层 | 主体 → 动作**白名单**（无参数谓词） | 403 `WHITELIST_DENIED`（[30](30-api.md)） | 安全日志 |
| 代码层 | `execute` 内用 `ctx.userId` / `ctx.groups` 自判，不满足抛 `PermissionDenied` | 403 `PERMISSION_DENIED` | 安全日志 |

- `execute` 内代码**全量可见数据**：行级谓词只管读面（[50](50-security.md)）；动作本身就是被治理的写路径。导入/管理类动作天然需要全量可见——不卡。
- 白名单与读授权均为运行时数据（超管经管理面配置），本体 DSL 只声明结构、不含授权。

## 8. 并发与重试

- `ctx.modify` 可选传 `expectedUpdatedAt`（复用引擎 If-Match 语义，锚 `updated_at`）：命中旧值 → 冲突，**整个事务回滚** → 409 `PRECONDITION_FAILED`。
- **无幂等键**。重试语义（normative，写入 API 文档）：网络超时后盲目重试**可能双花**；带 `expectedUpdatedAt` 重试安全（冲突即失败）；业务键 `unique` 约束天然兜底升幂等。
- 缺省并发策略 = 最后写入胜（LWW）。

## 9. 效应边界

v1 动作事务内**唯一效应 = 写本体**（对象表即权威态）。以下显式推迟 v2（[90](90-appendix.md)）：副作用规则、外部系统写回、多步编排（多请求/多动作部分成功语义）；动作 ↔ 注册函数调用桥与安全作用域叠加——v1 运行时无调用桥，`execute` 内复用逻辑 = 普通 TS import（代码组合，无治理概念）。

## 10. 审计日志

同库只追加表，每个**已提交**动作一行：

| 字段 | 内容 |
|---|---|
| 动作 | apiName |
| 时间 | 时间戳 |
| 主体 | 主体 id + 类型（用户/服务账号）+ 所用 token id |
| 入参 | 默认值填充后**原样记录**（v1 不脱敏——已知限制，token 永不出现在入参） |
| 编辑集 | 逐对象 `type + id + op` |
| 并发 | `expectedUpdatedAt` 是否使用 |
| 事务 | 事务 id、耗时 |

- **回滚不落审计**（回滚 = 无事发生）；认证/授权拒绝记**独立安全日志**（[50](50-security.md)）。
- **导入批次**为审计的另一种条目类型：每接入端点请求一条（主体/时间/请求 id/逐类型操作计数/来源标记），不记逐对象明细（[70](70-operations.md)）。
- 查询：只读管理端点，复用引擎过滤包（[30](30-api.md)）；v1 不主动清理。

## 11. 只读函数（queryFn）——逻辑支柱的 v1 接口位

```ts
export const departmentRoster = queryFn({
  apiName: 'department-roster',
  params: { department: p.ref(() => Department).required() },
  execute: (q, { department }) =>
    q.linked(Department, department, 'employees').map((e) => ({ id: e.id, name: e.name })),
});
```

- 与 `action` 同构（apiName/params/execute）；`q` 为**只读上下文**：`linked` / `backlinks` / 过滤查询，**无** create/modify/delete/link/unlink。
- 经 `POST /v1/functions/{name}/invoke` 暴露（[30](30-api.md)）；同步执行。
- 读授权照常生效（`q` 的每次读取经行级谓词编译，[50](50-security.md)）。

## 12. 已知限制与 v2（详见 [90](90-appendix.md)）

无幂等键；入参不脱敏；无调用桥/作用域叠加；无副作用/写回/多步编排；无请求内多动作提交与部分成功；无声明式 criteria/规则层。

---
*决策史：ADR-0003（九决策 + Palantir 对齐/偏离表）、ADR-0002（事务原语）、ADR-0004（两层权限）、ADR-0005（导入批次）。*
