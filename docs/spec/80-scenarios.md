# 验收场景

> **范围**：示例本体（领域选型与语言构造覆盖）+ 端到端故事清单与叙事 + 覆盖矩阵（规格完整性的硬验收判据）。
> **不含**：新语义（故事只组合既有决议）；矩阵与叙事冲突时以各章为准。
> **素材**：[#14 决议](https://github.com/0xnicholas/heirloom-pro/issues/14)；示例本体冻结自 [#12 原型 `ontology.ts`（归档分支）](https://github.com/0xnicholas/heirloom-pro/blob/prototype/ts-dsl-shape/prototype/ts-dsl-shape/ontology.ts)。
> **待落位**：无。
> **验收线**：深规格（[#13](https://github.com/0xnicholas/heirloom-pro/issues/13) 决议：覆盖矩阵闭合 = 完成硬判据）

## 规范性地位（#14 决议）

- **覆盖矩阵为规范性**：规格宣布完成**必须**满足——每条决议点至少被一条故事锚定；矩阵不闭合，规格不得宣布完成。
- **故事叙事为资料性**：每条故事的预期行为与正文各章（10/20/30/40/50/60/70）**必须**一致；如有冲突，以各章为准，并修正故事。

## 示例本体（#14 决议：沿用冻结）

规格示例本体 = [#12 原型（归档分支）](https://github.com/0xnicholas/heirloom-pro/blob/prototype/ts-dsl-shape/prototype/ts-dsl-shape/ontology.ts)的 HR/项目域，**冻结沿用**：Department / Employee / Skill / Project / Membership（+ Address、Money struct），动作 createDepartment / hireEmployee / grantSkill / createProject / assignToProject / transferEmployee / adjustSalary / offboardEmployee，queryFn departmentRoster / projectTeam。语言构造全覆盖：struct 复用、九类标量、数组+unique、就地约束、1:1/1:N/M:N、载荷升级中间对象、动态默认、ValidationFailed、乐观锁、无 upsert 查建两步、link 即移动、删除语义、只读函数接口位。

- #12 若调整 DSL 外形，示例本体**同步跟进**（两票互检：外形改则本体改）。
- 故事需要的安全面素材（主体、授权、PAT）在场景层补充，不改本体语言面。已落定：S3 行级谓词切分用**本类型 enum 属性**（`employee.status`，非反规范化属性）——谓词仅限本类型属性的毛刺就此闭合（[50](50-security.md) §6）。
- 已知毛刺：见上行（已落定）。

## 故事清单（S0–S11，#14 决议）

| # | 故事 | 锚定决议点 | 落章 |
|---|---|---|---|
| S0 | 部署引导：compose 起栈→自动迁移→引导超管→签发 PAT | ADR-0005、0004、0006（运行时环境） | 70/50 |
| S1 | 本体推送：CLI push 首版本体 | ADR-0007（期望态收敛、revision） | 60 |
| S2 | 批量接入：服务账号经接入端点导入存量，批次审计一条 | ADR-0005 | 70/20 |
| S3 | 读授权两态：全类型授权 vs 谓词收窄；静默收窄、零授权=零行 | ADR-0004 + ADR-0008（零行=200） | 50/30 |
| S4 | 录用正反路径：动态默认→ValidationFailed→422→回滚无审计→修正成功→审计一条 | ADR-0003 + ADR-0008（invoke/422 编码） | 20/30 |
| S5 | 并发调薪：双发 adjustSalary，expectedUpdatedAt→409 回滚 | ADR-0003 | 20 |
| S6 | 白名单两拒：引擎层白名单拒 vs execute 内 PermissionDenied；安全日志形状各一 | ADR-0004 | 50 |
| S7 | 链接全家桶：transfer（link 即移动）、grantSkill（无 upsert 查建）、assign（载荷升级+同事务引用） | ADR-0001、0003 | 10/20 |
| S8 | 删除语义：先清 Membership（required 阻止）→删员工；技能 optional 自动摘链 | ADR-0002 | 40 |
| S9 | 查询包：嵌套过滤+一跳链接过滤+keyset+count+include 2 跳；queryFn 花名册 | ADR-0002 + ADR-0008（query 端点形状） | 30/40 |
| S10 | 演化小步：加属性再 push，变更分类学落点 | ADR-0007（三档矩阵+联动校验） | 60 |
| S11 | 审计与安全日志查询：管理面只读端点、过滤 | ADR-0003/0004 + ADR-0008（admin 端点形状） | 30/50 |

## 故事叙事（S0–S11，资料性）

冲突规则：叙事与正文各章冲突时，**以各章为准**（#14 决议）。示例本体 apiName 全部取自冻结文件（§ 示例本体）。

### S0 部署引导（70/50）

```bash
docker compose up -d   # app + postgres 两服务（70 §6）；DATABASE_URL 唯一抽象
heirloom admin tokens create --subject user:admin-01
# → { "tokenId": "tok_…", "token": "hlk_…" }   明文仅此一次（30 §4.3）
```

1. app 启动 → 引擎 schema 迁移自动执行（advisory lock 防并发，70 §7）。
2. 环境变量引导首个超管（50 §3）；超管经管理面签发 PAT（引导凭据的产生机制为实现自由度，叙事不锁）。
3. 以 PAT 调 `GET /v1/admin/audit` → 200：引导闭环。

### S1 本体推送（60）

```bash
heirloom ontology apply ./ontology
```

1. CLI Node 进程求值本体 TS 模块 → registry → 定义 JSON → `PUT /v1/admin/ontology`（60 §2）。
2. 服务端 diff(空, 期望) → 全部自动档（建表/建索引）→ 单事务收敛 → `200 {"revision": 1, "changes": {"auto": 9, "dataValidation": 0}}`。
3. push 审计行一条：revision 0→1、主体、逐类别计数（60 §3）。
4. 重复推同一期望态 → `{"revision": 1, "noop": true}`：不涨 revision、不落审计（幂等）。

### S2 批量接入（70/20）

前置：超管建服务账号 `svc:hr-sync` + 授予接入授权 + 签发 PAT（30 §4）。

```bash
heirloom import employees.csv --type employee --source hr-sync
# 客户端转换（70 §3）；1400 行 → CLI 自动分 2 批（≤1000/批，40 §8）
```

1. 每批 = `POST /v1/admin/ingest` 单事务；200 回执 requestId + 逐类型计数。
2. 审计「导入批次」条目**每批一条**（主体/时间/请求 id/计数/来源；不记逐对象，70 §4）。
3. 批内一条违 `employeeNo` unique → 整批回滚 + 409 `UNIQUE_CONFLICT` 违规条目清单（含 index 定位）；审计条目照落、计数为 0。

### S3 读授权两态（50/30）

超管配置（运行时数据，50 §9）：组 `hr` → read-grant `employee` **无谓词**；组 `manager` → read-grant `employee` 谓词 `{"status": {"eq": "active"}}`（查询包同款算子、仅本类型属性——毛刺落定：enum 属性 status）。

1. `hr` 成员查询 → 全体员工 200。
2. `manager` 成员同一查询 → 仅 active 行（on-leave/offboarded 静默剔除，不报错，50 §7）。
3. 两纽皆无的主体 → 200 `{"data": []}`：零授权 = 零行 = 空集，三者在响应上不可区分（50 §5）。

### S4 录用正反路径（20/30）

部门「平台部」budget `"1200000"`（decimal 字符串）。反向先来：

```http
POST /v1/actions/hire-employee/invoke
{ "employeeNo": "E1024", "name": "李四", "department": "<uuid>",
  "salary": "1500000", "address": { "street": "…", "city": "上海", "zip": "200000" } }
→ 422 { "error": { "code": "VALIDATION_FAILED",
       "details": { "salary": "年薪 ¥1500000 超过部门「平台部」预算 ¥1200000" } } }
```

1. 整事务回滚：无员工、无部门链接；**审计无行**（回滚 = 无事发生，20 §10）。
2. `hiredAt` 省缺 → 动态默认 `ctx.today` 填充（20 §3）。
3. 修正 salary `"950000"` 重发 → 200 `{"employeeId": "018f…"}`；审计一条：动作 apiName、入参（含默认填充）、编辑集 = create employee + link department.employees、事务 id/耗时。

### S5 并发调薪（20）

两管理员同秒双发 `adjust-salary`，均带同一旧 `expectedUpdatedAt`：

1. 先到者：modify 命中 → 200，审计一条。
2. 后到者：`updated_at` 已变 → 整事务回滚 → 409 `PRECONDITION_FAILED`；审计无行。
3. 若都不带 expectedUpdatedAt → LWW 双 200（最后写入胜，20 §8）。

### S6 白名单两拒（50）

场景层示例（不改冻结本体——安全面素材场景层补充，#14 决议）：

1. 主体未入 `adjust-salary` 白名单 → 引擎层 403 `WHITELIST_DENIED`（不进 execute）；安全日志：主体/动作/原因/时间戳。
2. 若 `adjustSalary` 作者在 execute 内写 `if (!ctx.groups.includes('hr')) throw new PermissionDenied()`：白名单内但非 hr 组 → 403 `PERMISSION_DENIED`（事务回滚）；安全日志同形状。
3. 两拒均**不落审计**；查询永不因授权落日志（零行=200 特性，50 §10）。

### S7 链接全家桶（10/20）

1. `transfer-employee`（1:N）：`ctx.link(Department, 新部门, 'employees', emp)` → link 即移动，旧部门侧自动摘除。
2. `grant-skill`（M:N，无 upsert 查建）：`ctx.all(Skill).find(...) ?? ctx.create(Skill, …)` → RYW 使同事务内第二次授予同名技能查得到刚建的；(from,to) 主键保证集合语义。
3. `assign-to-project`（载荷升级 + 同事务引用）：`ctx.create(Membership)` + 两条 required 链接（employee/project）提交时校验（10 §4）；UUIDv7 事务前预生成使「先建后链」可行（40 §5）。

### S8 删除语义（40）

对有名下 Membership 的员工调 `offboard-employee`：

1. `Membership.employee` 为 required manyToOne → FK `RESTRICT` → 409 `LINK_RESTRICTED`，details 列引用方（type=membership、id、linkName=employee）（40 §4）。
2. 先删 Membership 行（本例经接入端点 delete 操作——FK 持方自身删除无额外动作）→ 再 `offboard-employee` → 200。
3. 随删自动处理：`skills` M:N 链接表行 CASCADE；他人员工的 `mentor` 指向此员工（optional 1:1）→ SET NULL（mentee 变 null，不报错）。

### S9 查询包（30/40）

```jsonc
POST /v1/objects/department/query
{ "filter": { "and": [ { "employees.status": { "eq": "active" } },     // 一跳链接属性
               { "not": { "name": { "contains": "临时" } } } ] },      // 嵌套
  "sort": [{ "field": "name", "dir": "asc" }],                     // id 隐式末位锥
  "limit": 100, "count": true,
  "include": ["employees", "employees.mentor"] }                   // ≤2 跳/条
```

1. 200：`{data, nextCursor?, count}`；include 各跳按各自行级谓词过滤（不可见员工剔除——多值变短）。
2. 传 `nextCursor` 拉下一页，keyset 锥保证排序稳定（40 §6）。
3. `POST /v1/functions/department-roster/invoke` `{"department": "<uuid>"}` → 只读 `q` 遍历投影；读授权照常生效（20 §11）。

### S10 演化小步（60）

本体源码给 Employee 加可选属性 `title: p.string()`，再 push：

1. diff → 加可选属性 → **自动档** `ADD COLUMN`（存量行 NULL）→ `{"revision": 2, "changes": {"auto": 1}}`；SDK 同源重编译获得新字段（60 §8）。
2. 反例：把 `salary` 改 required（无 default）→ **拒绝档** 422 `PUSH_REJECTED_BREAKING`，details 带 remedy（带 default 重推或一次性动作通道，60 §5）。
3. 联动校验：同 push 若删被 `manager` 组谓词引用的 `status` → 悬空引用先拒（422，码同拒绝档，60 §7/30 §4.1）——即便删空探测本身可通过。

### S11 审计与安全日志查询（30/50）

```http
GET /v1/admin/audit?kind=action&action=hire-employee&cursor=…
GET /v1/admin/security-log?code=WHITELIST_DENIED&after=…
```

1. 超管 keyset 过滤只读：动作条目（S4）与导入批次条目（S2）同面可查。
2. 安全日志：S6 两拒各一条、S0 起无效 token 条目——与审计分立（50 §10）。
3. 非超管调任一 → 403 `ADMIN_FORBIDDEN` + 落安全日志。

## 覆盖矩阵（规范性）

| 决议点 | 锚定故事 | 状态 |
|---|---|---|
| ADR-0001 本体语言核心（类型/属性/链接/约束） | S7（+示例本体全构造） | ✓ |
| ADR-0002 存储映射（查询包/删除语义） | S8、S9 | ✓ |
| ADR-0003 动作（校验/乐观锁/审计/RYW） | S4、S5、S7、S11 | ✓ |
| ADR-0004 安全（PAT/读授权/白名单/安全日志） | S0、S3、S6、S11 | ✓ |
| ADR-0005 接入与部署 | S0、S2 | ✓ |
| ADR-0006 语言与运行时（环境性前提） | S0 | ✓ |
| #12 TS DSL 外形 | 示例本体即反应物（S1/S4/S7 全体） | ✓ |
| #6 本体定义与演化 | S1、S10 | ✓ |
| #10 API 与逻辑接口 | S3、S4、S9、S11 编码面 | ✓ |

（故事叙事见上，资料性；冲突以各章为准。）
