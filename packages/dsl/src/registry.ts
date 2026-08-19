/**
 * 注册表 —— DSL 声明的进程内收集器（spec 60 §2.1：CLI 求值本体 TS 模块，
 * 类型/属性/链接/动作/queryFn 注册进同一 registry，再物化为定义 JSON）。
 */

import type { ActionMarker } from "./action.js";
import type { ObjectTypeMarker } from "./object.js";
import type { StructMarker } from "./struct.js";
import type { QueryFnMarker } from "./action.js";

class Registry {
  readonly objectTypes = new Map<string, ObjectTypeMarker<any, any>>();
  readonly structs = new Map<string, StructMarker<any>>();
  readonly actions = new Map<string, ActionMarker<any>>();
  readonly functions = new Map<string, QueryFnMarker<any>>();

  reset(): void {
    this.objectTypes.clear();
    this.structs.clear();
    this.actions.clear();
    this.functions.clear();
  }

  get isEmpty(): boolean {
    return (
      this.objectTypes.size === 0 && this.structs.size === 0 && this.actions.size === 0 && this.functions.size === 0
    );
  }
}

/**
 * 全局 registry：本体模块求值时构建器自动登记。
 * 模块级单例与 registry 的存在同寿命；测试用 reset() 隔离。
 */
export const registry = new Registry();

export function registerObjectType(def: ObjectTypeMarker<any, any>): void {
  if (registry.objectTypes.has(def.apiName)) {
    throw new Error(`对象类型 apiName 重复注册：${def.apiName}`);
  }
  if (registry.structs.has(def.apiName)) {
    throw new Error(`apiName 与既有 struct 冲突：${def.apiName}`);
  }
  registry.objectTypes.set(def.apiName, def);
}

export function registerStruct(def: StructMarker<any>): void {
  if (registry.structs.has(def.apiName)) throw new Error(`struct apiName 重复注册：${def.apiName}`);
  if (registry.objectTypes.has(def.apiName)) {
    throw new Error(`apiName 与既有对象类型冲突：${def.apiName}`);
  }
  registry.structs.set(def.apiName, def);
}

export function registerAction(def: ActionMarker<any>): void {
  if (registry.actions.has(def.apiName)) throw new Error(`action apiName 重复注册：${def.apiName}`);
  if (registry.functions.has(def.apiName)) {
    throw new Error(`action 与 function apiName 冲突：${def.apiName}`);
  }
  registry.actions.set(def.apiName, def);
}

export function registerQueryFn(def: QueryFnMarker<any>): void {
  if (registry.functions.has(def.apiName)) throw new Error(`queryFn apiName 重复注册：${def.apiName}`);
  if (registry.actions.has(def.apiName)) {
    throw new Error(`function 与 action apiName 冲突：${def.apiName}`);
  }
  registry.functions.set(def.apiName, def);
}
