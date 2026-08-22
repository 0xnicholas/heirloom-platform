/**
 * OpenAPI 3 静态文档 —— 端点集固定、不随本体变（spec 30 §5：静态固定面；
 * 逐本体 OpenAPI/SDL 生成 → v2）。手写 JSON（无运行时依赖）：
 * 与 app.ts 路由同源维护，测试断言两者一致（路径集合相等）。
 */
export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: { url: string; description?: string }[];
  components: Record<string, unknown>;
  paths: Record<string, any>;
}

const ERROR_ENVELOPE = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string", description: "错误码（注册表见 spec 90 附录）" },
        message: { type: "string" },
        details: { description: "形状随 code 固定" },
      },
      required: ["code", "message"],
    },
  },
  required: ["error"],
};

const SECURITY = [{ bearerAuth: [] }];

function jsonBody(description: string, schema: any): any {
  return {
    required: true,
    content: { "application/json": { schema } },
    description,
  };
}

function ok(description: string, schema: any): any {
  return {
    description,
    content: { "application/json": { schema } },
  };
}

function respRange(...codes: [string, string][]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [code, desc] of codes) {
    out[code] = code === "200" ? { description: desc } : { description: desc, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
  }
  return out;
}

export function buildOpenApiDocument(opts: { serverUrl?: string } = {}): OpenApiDocument {
  const paths: Record<string, any> = {};

  // ── 语义面（spec 30 §3）──
  paths["/v1/objects/{type}/query"] = {
    post: {
      summary: "对象查询（spec 30 §3.1）",
      security: SECURITY,
      parameters: [{ name: "type", in: "path", required: true, schema: { type: "string" }, description: "对象类型 apiName（kebab-case）" }],
      requestBody: jsonBody("查询体：filter/sort/cursor/limit/include/count（算子封闭集见 spec 40 §6）", {
        type: "object",
        properties: {
          filter: { type: "object", description: "过滤表达式：and/or/not 任意嵌套；字段键 = 本类型属性 + 一跳链接属性点路径" },
          sort: { type: "array", maxItems: 3, items: { type: "object", properties: { field: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } }, required: ["field", "dir"] } },
          cursor: { type: "string", description: "不透明 keyset 游标（客户端不得解析或自行构造）" },
          limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
          include: { type: "array", items: { type: "string" }, description: "点路径；每条链 ≤2 跳" },
          count: { type: "boolean", default: false },
        },
      }),
      responses: respRange(
        ["200", "查询结果（零授权类型 = 空集，静默收窄——永不 403）"],
        ["400", "请求体畸形"],
        ["401", "认证失败"],
        ["404", "类型不存在"],
        ["422", "查询体越限（sort/limit/include）"],
      ),
    },
  };

  paths["/v1/objects/{type}/{id}"] = {
    get: {
      summary: "单对象取（spec 30 §3.2）",
      security: SECURITY,
      parameters: [
        { name: "type", in: "path", required: true, schema: { type: "string" } },
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        { name: "include", in: "query", schema: { type: "array", items: { type: "string" } }, description: "可重复；形状同查询体 include" },
        { name: "If-Match", in: "header", schema: { type: "string" }, description: "updated_at 并发头；命中旧值 → 409" },
      ],
      responses: respRange(
        ["200", "命中（id 不存在或不可见 → 同形 404）"],
        ["401", "认证失败"],
        ["404", "不存在或不可见"],
        ["409", "If-Match 命中旧值"],
      ),
    },
  };

  paths["/v1/actions/{apiName}/invoke"] = {
    post: {
      summary: "动作调用（spec 30 §3.3：同步、单事务）",
      security: SECURITY,
      parameters: [{ name: "apiName", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody("参数对象（键 = 参数名；ref 参数传 UUID，引擎预取注入完整对象）", { type: "object", additionalProperties: true }),
      responses: respRange(
        ["200", "动作结果（execute 返回值）"],
        ["400", "请求体畸形/未知参数"],
        ["401", "认证失败"],
        ["403", "白名单拒 / PermissionDenied"],
        ["404", "动作不存在"],
        ["409", "乐观锁 / unique / required 链接阻删"],
        ["422", "参数校验失败（逐字段）"],
        ["500", "内部错误（含事务超时）"],
      ),
    },
  };

  paths["/v1/functions/{apiName}/invoke"] = {
    post: {
      summary: "只读函数调用（spec 30 §3.4；读授权照常生效）",
      security: SECURITY,
      parameters: [{ name: "apiName", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody("参数对象", { type: "object", additionalProperties: true }),
      responses: respRange(
        ["200", "函数结果"],
        ["400", "请求体畸形/未知参数"],
        ["401", "认证失败"],
        ["404", "函数不存在"],
        ["422", "参数校验失败"],
      ),
    },
  };

  paths["/v1/meta/ontology"] = {
    get: {
      summary: "introspection（spec 30 §3.5）",
      security: SECURITY,
      responses: respRange(["200", "当前生效定义 + revision"], ["401", "认证失败"]),
    },
  };

  // ── 管理面（spec 30 §4）──
  paths["/v1/admin/ontology"] = {
    put: {
      summary: "push：全量期望态收敛（spec 30 §4.1 / 60 §2–§3）",
      security: SECURITY,
      requestBody: jsonBody("定义 JSON（语言中性；execute 源文本随定义传输）", { type: "object", additionalProperties: true }),
      responses: respRange(
        ["200", "收敛完成或 no-op"],
        ["400", "定义结构校验先行拒绝"],
        ["401", "认证失败"],
        ["403", "非超管"],
        ["422", "三档拒绝（PUSH_REJECTED_BREAKING / PUSH_REJECTED_DATA_VALIDATION）"],
      ),
    },
  };

  paths["/v1/admin/ingest"] = {
    post: {
      summary: "批量接入（spec 30 §4.2 / 70 §2：唯一非超管例外 = 持接入授权的服务账号）",
      security: SECURITY,
      requestBody: jsonBody("operations ≤1000；create/modify/delete", {
        type: "object",
        required: ["operations"],
        properties: {
          source: { type: "string", description: "调用方自报来源（如 hr-sync）" },
          operations: {
            type: "array", maxItems: 1000,
            items: {
              type: "object",
              oneOf: [
                { type: "object", properties: { type: { type: "string" }, op: { type: "string", enum: ["create"] }, object: { type: "object" } }, required: ["type", "op", "object"] },
                { type: "object", properties: { type: { type: "string" }, op: { type: "string", enum: ["modify"] }, id: { type: "string", format: "uuid" }, patch: { type: "object" } }, required: ["type", "op", "id", "patch"] },
                { type: "object", properties: { type: { type: "string" }, op: { type: "string", enum: ["delete"] }, id: { type: "string", format: "uuid" } }, required: ["type", "op", "id"] },
              ],
            },
          },
        },
      }),
      responses: respRange(
        ["200", "requestId + 逐类型计数"],
        ["400", "操作条目畸形"],
        ["401", "认证失败"],
        ["403", "无接入授权"],
        ["409", "unique 冲突 / required 链接阻删（违规条目清单）"],
        ["413", "批量 >1000"],
        ["422", "约束违例（违规条目清单）"],
      ),
    },
  };

  for (const [path, summary] of [
    ["/v1/admin/audit", "审计查询（kind/action/requestId 过滤 + keyset，spec 30 §4）"],
    ["/v1/admin/security-log", "安全日志查询（code/subject 过滤 + keyset）"],
  ] as const) {
    paths[path] = {
      get: {
        summary,
        security: SECURITY,
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000, default: 100 } },
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "after", in: "query", schema: { type: "string" } },
        ],
        responses: respRange(["200", "日志行（新在前）"], ["401", "认证失败"], ["403", "非超管"]),
      },
    };
  }

  for (const [path, item] of [
    ["/v1/admin/subjects", {
      post: { summary: "建主体（user/service 同构）", security: SECURITY, requestBody: jsonBody("kind/name/isAdmin", { type: "object", required: ["kind", "name"], properties: { kind: { type: "string", enum: ["user", "service"] }, name: { type: "string" }, isAdmin: { type: "boolean" } } }), responses: respRange(["200", "subjectId"], ["400", "畸形"], ["403", "非超管"]) },
      get: { summary: "主体列表（含组名）", security: SECURITY, responses: respRange(["200", "列表"], ["403", "非超管"]) },
    }],
    ["/v1/admin/subjects/{id}", {
      patch: { summary: "改主体（name/isAdmin）", security: SECURITY, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody("patch", { type: "object" }), responses: respRange(["200", "updated"], ["404", "不存在"], ["403", "非超管"]) },
      delete: { summary: "删主体", security: SECURITY, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: respRange(["200", "deleted"], ["404", "不存在"], ["403", "非超管"]) },
    }],
    ["/v1/admin/groups", {
      post: { summary: "建组（扁平不嵌套）", security: SECURITY, requestBody: jsonBody("name", { type: "object", required: ["name"], properties: { name: { type: "string" } } }), responses: respRange(["200", "groupId"], ["400", "畸形"], ["403", "非超管"]) },
      get: { summary: "组列表", security: SECURITY, responses: respRange(["200", "列表"], ["403", "非超管"]) },
    }],
    ["/v1/admin/groups/{id}", {
      delete: { summary: "删组", security: SECURITY, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: respRange(["200", "deleted"], ["404", "不存在"], ["403", "非超管"]) },
    }],
    ["/v1/admin/groups/{id}/members", {
      post: { summary: "加组成员", security: SECURITY, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody("subjectId", { type: "object", required: ["subjectId"], properties: { subjectId: { type: "string" } } }), responses: respRange(["200", "added"], ["400", "畸形"], ["403", "非超管"]) },
    }],
    ["/v1/admin/groups/{id}/members/{subjectId}", {
      delete: { summary: "移除组成员", security: SECURITY, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "subjectId", in: "path", required: true, schema: { type: "string" } }], responses: respRange(["200", "removed"], ["403", "非超管"]) },
    }],
    ["/v1/admin/read-grants", {
      post: { summary: "授予读授权（类型级 + 谓词式行级；谓词禁链接游走）", security: SECURITY, requestBody: jsonBody("subjectId|groupId 恰一 + type + predicate?", { type: "object", required: ["type"], properties: { subjectId: { type: "string" }, groupId: { type: "string" }, type: { type: "string" }, predicate: { type: "object" } } }), responses: respRange(["200", "grantId"], ["400", "畸形"], ["403", "非超管"], ["422", "谓词校验失败"]) },
      get: { summary: "读授权列表", security: SECURITY, responses: respRange(["200", "列表"], ["403", "非超管"]) },
    }],
    ["/v1/admin/read-grants/{id}", {
      delete: { summary: "撤销读授权", security: SECURITY, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: respRange(["200", "deleted"], ["404", "不存在"], ["403", "非超管"]) },
    }],
    ["/v1/admin/action-grants", {
      post: { summary: "动作白名单授权（接入授权 = action: ingest）", security: SECURITY, requestBody: jsonBody("subjectId|groupId 恰一 + action", { type: "object", required: ["action"], properties: { subjectId: { type: "string" }, groupId: { type: "string" }, action: { type: "string" } } }), responses: respRange(["200", "grantId"], ["400", "畸形"], ["403", "非超管"]) },
      get: { summary: "动作授权列表", security: SECURITY, responses: respRange(["200", "列表"], ["403", "非超管"]) },
    }],
    ["/v1/admin/action-grants/{id}", {
      delete: { summary: "撤销动作授权", security: SECURITY, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: respRange(["200", "deleted"], ["404", "不存在"], ["403", "非超管"]) },
    }],
    ["/v1/admin/tokens", {
      post: { summary: "签发 PAT（明文仅此一次返回）", security: SECURITY, requestBody: jsonBody("subject（名）或 subjectId", { type: "object", properties: { subject: { type: "string" }, subjectId: { type: "string" } } }), responses: respRange(["200", "{tokenId, token}"], ["400", "畸形"], ["403", "非超管"], ["404", "主体不存在"]) },
      get: { summary: "token 列表（无明文）", security: SECURITY, responses: respRange(["200", "列表"], ["403", "非超管"]) },
    }],
    ["/v1/admin/tokens/{id}", {
      delete: { summary: "吊销 PAT（即时生效）", security: SECURITY, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: respRange(["200", "revoked"], ["404", "不存在或已吊销"], ["403", "非超管"]) },
    }],
  ] as const) {
    paths[path] = item as never;
  }

  // meta：OpenAPI 自身
  paths["/v1/meta/openapi"] = {
    get: {
      summary: "本 OpenAPI 文档（静态固定面，spec 30 §5）",
      security: SECURITY,
      responses: { 200: ok("OpenAPI 3 文档", { type: "object" }) },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Heirloom REST API",
      version: "1.0.0",
      description: "端点集对任意本体不变（spec 30 §1）；错误码注册表见规格 90 附录。零行 = 200 空集（静默收窄，永不 403）。",
    },
    ...(opts.serverUrl ? { servers: [{ url: opts.serverUrl }] } : {}),
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "PAT（hlk_ 前缀）" } },
      schemas: { Error: ERROR_ENVELOPE },
    },
    paths,
  };
}
