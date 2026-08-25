# ADR-0001：本体语言核心语义（v1）

- **状态**：已接受（2026-08-16）
- **来源**：wayfinder 票 [#5 本体语言核心语义](https://github.com/0xnicholas/heirloom-pro/issues/5)，父图 [#1](https://github.com/0xnicholas/heirloom-pro/issues/1)
- **输入**：[research/oss-landscape](https://github.com/0xnicholas/heirloom-pro/tree/research/oss-landscape)、[research/palantir-ontology](https://github.com/0xnicholas/heirloom-pro/tree/research/palantir-ontology)、[research/ts-postgres-stack](https://github.com/0xnicholas/heirloom-pro/tree/research/ts-postgres-stack)

## 背景

Heirloom 的对象类型由平台用户在**运行时定义**（对标 Palantir Ontology）。本体语言是四支柱中数据支柱的地基，其语义边界直接决定存储映射（#7）、动作语义（#8）、安全模型（#9）与 TS DSL 外形（#12）。本 ADR 锁定语言核心的八个决策点。

## 决策

1. **object + struct 二分**：object type（有身份、可链接、可独立查询、可授权）与 struct（无身份、嵌入宿主、随宿主删除）两级分立。跨系统最强共识（TerminusDB subdocument / Atlas struct-entity / TypeDB attribute-entity 三处独立收敛）。
2. **标量九类**：`string` / `boolean` / `integer`（±2^53 JSON 安全）/ `float` / `decimal`（API 层 JSON 字符串编码，规避 Palantir 踩过的 JSON/精度坑）/ `date` / `datetime` / `enum` / `json` 逃生舱。不做 byte/short/vector/uuid 标量。
3. **数组属性，元素限值**：`scalar[]` / `enum[]` / `struct[]`；默认保序、允许重复，声明 `unique` 转集合语义。**对象引用不得入属性**——引用一律走链接（保住基数校验、权限、链接一等语义）。
4. **宽松声明 + 就地约束**：属性默认可选，`required` 显式（演化友好：后加属性不破存量）；默认值仅静态字面量；`range` / `length` / `regex` / `unique` 就地声明。动态默认（now()/当前用户）与跨字段组合校验归动作层（对齐 Palantir 的值来源分层）。
5. **一等链接，三档基数**：独立于属性声明；单侧声明、正向命名 + 反向命名（可派生）、双侧可游走；`1:1` / `1:N` / `M:N`；`required` 可选，写事务校验。物理映射（外键 vs 链接表）归 #7。
6. **v1 无链接属性**：链接不携带数据；载荷需求（Membership 的 role/since）升级为中间对象类型 + 两条 1:N。升级路径单一，避免「链接载荷 vs 中间对象」双轨。
7. **无继承、无接口**：共享形状用 struct 复用；跨类型操作（「归档任何可归档物」）留 v2 接口。依据：TypeDB 建模指南「组合优于层级」、oss-landscape 避坑清单第 3 条。
8. **服务端 UUID 主键**：语言层不声明主键；业务键 = `unique` 约束；ID 创建后不可变、对外不透明（无 IRI 泄漏）。

**附带**：命名元数据骨架 `apiName` + `displayName` + `description`（每类型/属性/链接）；`status` 生命周期归本体演化（#6），不进语言核心。

## 后果

- 存储票 #7 拿到明确输入：object → 一类型一表（jsonb 属性）+ 关系表/外键；struct → jsonb 内嵌；链接 → 1:1/1:N 外键列、M:N 独立链接表，均无载荷。
- 动作票 #8 接走动态默认与跨字段校验的职责边界。
- n 元关系、继承、接口、链接属性、vector/二进制标量全部显式推迟——进「Out of scope / v2」而非沉默缺失。
- `decimal` 的 JSON 字符串编码贯穿 API 与 SDK 生成，规格需写明编解码规则。
- v1 的多态能力为零：跨类型需求只能靠中间对象类型绕行，规格的示例本体应展示这一模式。
