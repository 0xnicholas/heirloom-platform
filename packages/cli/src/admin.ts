/**
 * `heirloom admin <subjects|groups|read-grants|action-grants|tokens> …`
 * —— 管理面端点 1:1 薄壳（spec 30 §7）。tokens create 支持 --subject 按名
 * 解析（S0 引导叙事：`--subject user:admin-01`）。
 */
import { api, type ClientOptions } from "./client.js";

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

export async function runAdmin(opts: ClientOptions, argv: string[]): Promise<void> {
  const [resource, verb, ...rest] = argv;
  const { flags } = parseFlags(rest);
  const out = (v: unknown): void => console.log(JSON.stringify(v, null, 2));

  if (resource === "subjects") {
    if (verb === "create") {
      out(await api(opts, "POST", "/v1/admin/subjects", { kind: str(flags.kind) ?? "user", name: str(flags.name), isAdmin: flags.admin === true }));
    } else if (verb === "list") {
      out(await api(opts, "GET", "/v1/admin/subjects"));
    } else if (verb === "delete") {
      out(await api(opts, "DELETE", `/v1/admin/subjects/${str(flags.id)}`));
    } else throw new Error(`用法：admin subjects create --kind user|service --name N [--admin] | list | delete --id ID`);
  } else if (resource === "groups") {
    if (verb === "create") {
      out(await api(opts, "POST", "/v1/admin/groups", { name: str(flags.name) }));
    } else if (verb === "list") {
      out(await api(opts, "GET", "/v1/admin/groups"));
    } else if (verb === "delete") {
      out(await api(opts, "DELETE", `/v1/admin/groups/${str(flags.id)}`));
    } else if (verb === "members" && rest[0] === "add") {
      out(await api(opts, "POST", `/v1/admin/groups/${str(flags.group)}/members`, { subjectId: str(flags.subject) }));
    } else if (verb === "members" && rest[0] === "remove") {
      out(await api(opts, "DELETE", `/v1/admin/groups/${str(flags.group)}/members/${str(flags.subject)}`));
    } else throw new Error(`用法：admin groups create --name N | list | delete --id ID | members add|remove --group G --subject S`);
  } else if (resource === "read-grants") {
    if (verb === "create") {
      const body: Record<string, unknown> = { type: str(flags.type) };
      if (str(flags.subject)) body.subjectId = str(flags.subject);
      if (str(flags.group)) body.groupId = str(flags.group);
      if (str(flags["predicate-json"])) body.predicate = JSON.parse(str(flags["predicate-json"])!);
      out(await api(opts, "POST", "/v1/admin/read-grants", body));
    } else if (verb === "list") {
      out(await api(opts, "GET", "/v1/admin/read-grants"));
    } else if (verb === "delete") {
      out(await api(opts, "DELETE", `/v1/admin/read-grants/${str(flags.id)}`));
    } else throw new Error(`用法：admin read-grants create --subject|--group ID --type T [--predicate-json '{…}'] | list | delete --id ID`);
  } else if (resource === "action-grants") {
    if (verb === "create") {
      const body: Record<string, unknown> = { action: str(flags.action) };
      if (str(flags.subject)) body.subjectId = str(flags.subject);
      if (str(flags.group)) body.groupId = str(flags.group);
      out(await api(opts, "POST", "/v1/admin/action-grants", body));
    } else if (verb === "list") {
      out(await api(opts, "GET", "/v1/admin/action-grants"));
    } else if (verb === "delete") {
      out(await api(opts, "DELETE", `/v1/admin/action-grants/${str(flags.id)}`));
    } else throw new Error(`用法：admin action-grants create --subject|--group ID --action A（接入授权 = --action ingest）| list | delete --id ID`);
  } else if (resource === "tokens") {
    if (verb === "create") {
      const body: Record<string, unknown> = {};
      if (str(flags.subject)) body.subject = str(flags.subject); // 按名（S0 叙事）
      if (str(flags.subjectId)) body.subjectId = str(flags.subjectId);
      out(await api(opts, "POST", "/v1/admin/tokens", body)); // 明文仅此一次
    } else if (verb === "list") {
      out(await api(opts, "GET", "/v1/admin/tokens"));
    } else if (verb === "revoke") {
      out(await api(opts, "DELETE", `/v1/admin/tokens/${str(flags.id)}`));
    } else throw new Error(`用法：admin tokens create --subject 名| --subjectId ID | list | revoke --id ID`);
  } else {
    throw new Error(`未知资源：${resource}（subjects|groups|read-grants|action-grants|tokens）`);
  }
}
