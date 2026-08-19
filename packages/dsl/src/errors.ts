/**
 * 结构化异常 —— 动作 execute 内的语义信封（spec 20 §4 / §7）。
 *
 * ValidationFailed = 逐字段参数校验失败（HTTP 422）；
 * PermissionDenied = 代码层授权拒绝（HTTP 403）。二者均使整事务回滚。
 */

export class ValidationFailed extends Error {
  override readonly name = "ValidationFailed";
  /** 逐字段消息：HTTP details 形状随 code 固定（spec 30 §6） */
  readonly fields: Record<string, string>;

  constructor(fields: Record<string, string>) {
    const first = Object.values(fields)[0];
    super(first ? `校验失败：${first}` : "校验失败");
    this.fields = fields;
  }
}

export class PermissionDenied extends Error {
  override readonly name = "PermissionDenied";

  constructor(reason: string) {
    super(reason);
  }
}
