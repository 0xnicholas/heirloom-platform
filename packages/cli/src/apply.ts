/**
 * `heirloom ontology apply <path>` —— esbuild 求值本体 TS 模块 → 物化定义
 * JSON → PUT /v1/admin/ontology（spec 60 §2 / 30 §7）。
 * esbuild 打包剥 TS 注解（实现自由度 4/6：execute 源文本必须纯 JS）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { materialize } from "@heirloom/dsl";
import { api, type ClientOptions } from "./client.js";

export async function buildDefinition(ontologyPath: string): Promise<unknown> {
  // 临时目录放包内：external 的 @heirloom/dsl 靠 node_modules 解析到
  // 同一实例（否则 bundle 内嵌另一份 dsl → 双 registry 空定义，M1 已知坑）
  const dir = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".heirloom-ontology-"));
  try {
    const outfile = join(dir, "ontology.bundle.mjs");
    await build({
      entryPoints: [ontologyPath],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      external: ["@heirloom/dsl"],
      logLevel: "silent",
    });
    const mod = (await import(pathToFileURL(outfile).href)) as Record<string, unknown>;
    const bindings = Object.fromEntries(Object.entries(mod).filter(([k]) => k !== "default"));
    return JSON.parse(JSON.stringify(materialize({ bindings: bindings as never })));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runApply(opts: ClientOptions, ontologyPath: string): Promise<void> {
  const definition = await buildDefinition(ontologyPath);
  const result = await api<{ revision: number; noop?: boolean; changes?: { auto: number; dataValidation: number } }>(
    opts,
    "PUT",
    "/v1/admin/ontology",
    definition,
  );
  if (result.noop) {
    console.log(`no-op（revision ${result.revision}：期望态 == 当前生效定义）`);
  } else {
    console.log(`收敛完成：revision ${result.revision}，${JSON.stringify(result.changes)}`);
  }
}
