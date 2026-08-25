/**
 * HTTP 薄客户端 —— SDK 运行时（CLI 同源复用）。
 *
 * 统一信封：成功 `{data, …}` 原样返回；失败抛 `ApiError`（spec 30 §6
 * 错误信封 `{error:{code,message,details?}}`）。URL/token 由调用方注入
 * （12-factor，spec 70 §8）。
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: unknown,
  ) {
    super(`HTTP ${status} ${code}`);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  url: string;
  token: string;
}

export async function request<T = unknown>(
  opts: ClientOptions,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${opts.url.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${opts.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const err = (json.error ?? {}) as { code?: string; details?: unknown; message?: string };
    throw new ApiError(res.status, err.code ?? "UNKNOWN", err.details);
  }
  return json as T;
}

/** 无附加头形态（与 CLI 既有调用面兼容） */
export async function api<T = unknown>(opts: ClientOptions, method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(opts, method, path, body);
}
