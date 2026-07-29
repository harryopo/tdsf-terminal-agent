// TDSF 魔改 (P4-T4.4): Skill 系统模块入口
// -----------------------------------------------------------------------------
// 统一从此文件导出所有 Skills 子模块（types/registry/loader/executor/store/组件），
// 供 sidebar、App、TdsfAgentPanel 等外部模块按需导入。

// === 执行器 / 加载器 ===
export { invokeSkill } from "./executor";
export { getBuiltinSync, loadSkills } from "./loader";
// === 注册中心 ===
export {
  dictToMetadata,
  getBuiltinSkills,
  inferCategory,
  readEnabledState,
  writeEnabledState,
} from "./registry";
// === 组件 ===
export { SkillCard } from "./SkillCard";
// TDSF 魔改: SkillContentDialog 不在此处静态 re-export，避免 streamdown 进入启动 bundle。
// 该组件仅在 SkillsPanel 内部通过 React.lazy 按需加载。
// TDSF 魔改 2026-07-28: SkillInvoker 已废弃（P0-2 方案A, 与 SkillContentDialog 功能重复且误导用户）
// 不再主动 export。调用入口已统一为 SkillContentDialog（"查看内容"按钮）
// export { SkillInvoker } from "./SkillInvoker";
export { SkillsPanel } from "./SkillsPanel";
// === 命令解析 ===
export { type ParsedSkillCommand, parseSkillCommand } from "./skillCommand";
// === Store ===
export {
  filterSkills,
  type SkillFilterTab,
  useSkillsStore,
} from "./skillsStore";
// === 类型 ===
export type {
  SkillCategory,
  SkillDict,
  SkillExecution,
  SkillHistoryEntry,
  SkillInvokeResponse,
  SkillInvokeResult,
  SkillListResponse,
  SkillMetadata,
  SkillSource,
} from "./types";
