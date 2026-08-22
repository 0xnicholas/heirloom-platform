/**
 * HTTP 薄客户端 —— CLI = 端点 1:1 薄壳（spec 30 §7：不引入独立语义）。
 * URL/token 来自 --url/--token 或 HEIRLOOM_URL/HEIRLOOM_TOKEN。
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

export async function api<T = unknown>(opts: ClientOptions, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${opts.url.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${opts.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
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

export function clientFromEnv(args: { url?: string; token?: string }): ClientOptions {
  const url = args.url ?? process.env.HEIRLOOM_URL ?? "http://127.0.0.1:3000";
  const token = args.token ?? process.env.HEIRLOOM_TOKEN;
  if (!token) {
    console.error("缺少 token（--token 或 HEIRLOOM_TOKEN）");
    process.exit(1);
  }
  return { url, token };
}
