/**
 * HTTP 薄客户端 —— 自 @heirloom/sdk 同源复用（spec 30 §7：CLI = 端点 1:1 薄壳）。
 * 本文件仅保留 CLI 侧环境装配（--url/--token 或 HEIRLOOM_URL/HEIRLOOM_TOKEN）。
 */
export { api, ApiError, request } from "@heirloom/sdk";
export type { ClientOptions } from "@heirloom/sdk";
import type { ClientOptions } from "@heirloom/sdk";

export function clientFromEnv(args: { url?: string; token?: string }): ClientOptions {
  const url = args.url ?? process.env.HEIRLOOM_URL ?? "http://127.0.0.1:3000";
  const token = args.token ?? process.env.HEIRLOOM_TOKEN;
  if (!token) {
    console.error("缺少 token（--token 或 HEIRLOOM_TOKEN）");
    process.exit(1);
  }
  return { url, token };
}
