# SDK 类型层 = 幻影直推，而非 codegen

ADR-0008 决议 1 把 TS SDK 定为 v1 线上面的一半，并要求「SDK 从本体源码同源编译跟上演化，服务端不签发」。「同源编译」有两条实现路线：从 definition JSON 生成 `.d.ts` + 客户端（codegen），或直接从本体模块的 DSL 标记泛型推导（幻影直推）。

**决定：幻影直推。** `createSdk({ ontology })` 直接消费本体模块的标记类型：对象形状复用 DSL 既有的 `RuntimeProps`/`InputProps` 投影，过滤/排序/include/invoke 面由构建器类（`StringProp`/`NumberProp`/…）匹配 + 标记幻影（`apiName`、基数、`execute` 返回值）推导，算子封闭集逐条镜像 spec 40 §6 的引擎执行矩阵。理由：

1. **字面兑现「同源」**：本体源码、SDK 类型面、应用代码在同一编译单元，演化即重新编译，无生成物、无构建步骤、无版本漂移窗口。
2. **地基准现成**：spec 10 §6 的幻影四轴管线就是为类型推断铺的（运行时零开销），直推只消费不新增运行时。
3. **codegen 的优势在 v1 不成立**：多语言客户端（Python/Go）→ v2+；服务端签发被 ADR-0008 明确否决。

代价与已知弱化（接受）：

- **自链接 thunk `(): any`**（TS 循环初始化硬限制，drizzle 同款）下游弱类型——`mentor.*` 的过滤/include 运行时可用、类型不覆盖。
- **反向链接 include** 同样弱类型（引擎按反向名唯一反查可解析，类型面只覆盖声明侧）。
- **泛型 `const` 推断不触发多余属性检查**——未知过滤属性类错误在 SDK 面不拦截（服务端 422 兑底），值类型错误照常拦截。
- 结构类型别名需要判别幻影：`ActionMarker` 与 `QueryFnMarker` 因 `ActionCtx ⊇ QueryCtx` 的参数逆变互可赋值，SDK 路由靠 `__hlCallable` 判别。

顺带修正：`prop.integer()/float()` 此前幻影值为字面量 `"number"`（非 `number`），本次一并修正为 `NumberProp<number>`。

被否：**codegen**（多一道生成步骤、且 v1 只有 TS 消费者）；**薄运行时不推类型**（「同源编译」声称实际未兑现）；**服务端签发 SDK**（与端点面对任意本体不变的决议矛盾）。
