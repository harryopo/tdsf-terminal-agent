// TDSF 魔改 2026-07-28: 轻量 ErrorBoundary, 防止单个组件抛错导致整页 rootChildren=0 空白.
// 用法: <ErrorBoundary fallback={<div>...</div>}><Component /></ErrorBoundary>
import { Component, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  fallback?: ReactNode;
};

type State = {
  hasError: boolean;
  error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // 打印到 console 便于调试, 但不阻塞渲染
    console.error("[ErrorBoundary] caught:", error, info);
    // TDSF debug: expose last error for CDP inspection
    if (typeof window !== "undefined") {
      (window as unknown as Record<string, unknown>).__lastBoundaryError__ = {
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack,
      };
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="flex h-full w-full items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
            <div className="space-y-2">
              <p>该区域加载失败, 已隔离错误.</p>
              <p className="text-[10px] text-muted-foreground/60">
                {this.state.error?.message ?? "未知错误"}
              </p>
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
