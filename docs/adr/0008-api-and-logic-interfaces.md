# ADR-0008：API 与逻辑接口

- **状态**：已接受（2026-08-19）
- **来源**：wayfinder 票 [#10 API 与逻辑接口](https://github.com/0xnicholas/heirloom-pro/issues/10)，父图 [#1](https://github.com/0xnicholas/heirloom-pro/issues/1)
- **输入**：[ADR-0002](0002-storage-engine-mapping.md)（查询包/If-Match/批量）、[ADR-0003](0003-action-semantics.md)（apply/ValidationFailed/queryFn 接口位/审计查询）、[ADR-0004](0004-minimal-security-model.md)（403-vs-404/管理面/零行语义）、[ADR-0005](0005-data-ingestion-deployment.md)（接入端点）、[ADR-0007](0007-ontology-evolution.md)（push 编码/三档拒绝）、根决策「第一界面=SDK+API」
- **关系**：消费全部前置 ADR 的移交项；30 章素材就此闭合；根决策表述修订（GraphQL → v2）。

## 背景

票面遗留：REST vs GraphQL；资源命名/分页/过滤约定；OpenAPI 生成；逻辑支柱接口位（函数注册/签名外形）。历代 ADR 共移交六类端点编码义务。

## 决策

1. **线上面 = REST 唯一**：v1 线上面 = REST 通用端点 + TS SDK；GraphQL（逐本体动态 SDL、resolver 语义、分页/授权渗透）**显式推迟 v2**——规格面翻倍不值。端点面对**任意本体不变**：additive 演化不改 API 面，SDK 同源编译即可跟上演化（承 ADR-0007 决议 7）。**修订根决策「TS DSL + REST/GraphQL」表述为「TS DSL + REST（GraphQL → v2）」**。被否：双面齐上（两套一致语义双倍规格面）；GraphQL 优先（SDK/CLI/管理面仍绕不开 REST）。
2. **端点拓扑六件套**：
   - `POST /v1/objects/{type}/query`：body `{filter, sort[≤3], cursor, limit, include[≤2跳]}`（过滤/排序算子集承 ADR-0002 决策 5）；响应统一 `{data: [...], nextCursor?}`，limit 默认 100、上限 1000。
   - `GET /v1/objects/{type}/{id}`：单对象取（可带 include）。
   - `POST /v1/actions/{apiName}/invoke` 与 `POST /v1/functions/{apiName}/invoke`：动词后缀对称，不与元数据读混淆；函数 = 逻辑支柱 v1 唯一接口位（ADR-0003 决策 7），同步执行、只读 `q`。
   - `GET /v1/meta/ontology`：introspection——当前生效定义 + revision（CLI/SDK 锚点）。
   - **OpenAPI = 静态固定面文档**：端点集不随本体变，实现导出 OpenAPI 3；逐本体 OpenAPI/SDL 生成 → v2。被否：GET 查询串过滤（嵌套 and/or 装不下）；逐本体 OpenAPI（与静态面矛盾）。
3. **错误模型四件**：统一信封 `{error: {code, message, details?}}`；**错误码注册表落 90 附录单一权威**（正文只引用）。状态码映射：**零行 = 200 空集**（静默收窄，永不 403）；403 = `WHITELIST_DENIED` / `PERMISSION_DENIED`（code 区分，均落安全日志）；404 = 类型/动作/函数名不存在、GET 对象 miss；409 = `PRECONDITION_FAILED`（乐观锁）/ `UNIQUE_CONFLICT`（带约束标识）；413 = `BATCH_TOO_LARGE`；422 = `VALIDATION_FAILED`（逐字段；动作 ref 参数对象不存在亦走此码，承 ADR-0003 决议 2）与 push 三档拒绝专属码 `PUSH_REJECTED_DATA_VALIDATION` / `PUSH_REJECTED_BREAKING`（逐变更明细）。被否：零行 403（破坏静默收窄）；ValidationFailed 走 400（与畸形请求混淆）。
4. **管理面 = /v1/admin/* 单伞**：`PUT /ontology`（push，承 ADR-0007）、`POST /ingest`（批量接入 ≤1000，**服务账号可调，其余 admin 端点仅超管**）、`GET /audit`、`GET /security-log`（keyset 过滤只读）、`/subjects` `/groups` `/read-grants` `/action-grants` 四组 CRUD、`POST /tokens` 签发（明文**仅返回一次**）+ `GET /tokens` + `DELETE /tokens/{id}`。**CLI 与端点 1:1 映射**（`heirloom ontology apply` → `PUT /ontology` 等）。被否：接入独立非 admin 路径（授权模型割裂）；授权并单端点（读写面混淆）。

## 后果

- 30 章（API 面）素材齐备，撰写就绪；S3/S4/S9/S11 编码面可回填，80 章覆盖矩阵可全闭合。
- 90 附录新增义务：错误码注册表（全量 code × 状态 × 场景）。
- 根决策表述修订同步进地图 Notes；GraphQL → v2 进 Out of scope。
- 全图决策面闭合：无剩余决策票，雾中最后一项（规格撰写拆票策略）待地图收尾评估。
- 已知限制进附录：无速率限制；无逐本体 OpenAPI；GraphQL 缺席 v1。
