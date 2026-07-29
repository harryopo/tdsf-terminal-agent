// TDSF 魔改 (2026-07-28): 后端日志 Section
// -----------------------------------------------------------------------------
// 子审查 agent 专用入口: 不需要进入开发 agent 上下文, 直接在 UI 看到所有
// Python sidecar 日志 (level filter / 清空 / 自动滚动 / 暂停).
//
// 后端通路:
//   - core/log_capture.py: 5000 行 ringbuffer + log.tail JSON-RPC + sidecar:log 事件
//   - Tauri Rust: 转发 sidecar:* 事件到前端
//   - 前端: SidecarLogPanel (src/modules/logs/SidecarLogPanel.tsx)
//
// 触发方式:
//   - 设置 tab "后端日志"
//   - emit('tdsf:settings-tab', 'logs') 程序化跳转

import { SidecarLogPanel } from "@/modules/logs";
import { SectionHeader } from "../components/SectionHeader";

export function LogsSection() {
  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="后端日志"
        description="查看 Python Sidecar 的所有日志输出。子审查 agent 专用通路, 与开发 agent 隔离。"
      />
      <div className="h-[60vh] min-h-[400px]">
        <SidecarLogPanel className="h-full" />
      </div>
    </div>
  );
}
