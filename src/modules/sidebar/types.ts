// TDSF 魔改 (P4-T4.4): 新增 "skills" 视图 (Skill 管理面板)
// TDSF 修复 2026-08-01: 移除 "ssh" 视图——SSH 登录统一走"新建工作区"流程
// （SpaceCreateDialog），左侧不再保留独立 SSH 面板。
export type SidebarViewId = "explorer" | "source-control" | "skills" | "knowledge";
