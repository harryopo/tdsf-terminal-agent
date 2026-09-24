// TDSF 2026-07-28: 轻量 ErrorBoundary, 防止单个组件抛错导致整页 rootChildren=0 空白.
// 用法: <ErrorBoundary fallback={<div>...</div>}><Component /></ErrorBoundary>
//
// 2026-09-24 (#125) 补三件事，起因是用户实测「窗口卡住了」——量出来是白屏：
// React 18 在没有边界覆盖的渲染路径上抛错会把**整棵树卸载**，`#root` 子节点归 0。
// 边界其实 7-28 就存在，但只包住了侧栏那一格，崩的是挂在 App 顶层的弹窗 ⇒ 没人接。
// ① `label`：提示必须说清**是哪一块**崩了。只写"出错了"等于把四种原因糊成一句
//    （同 #118 那条教训），用户无法判断该重试还是该关掉哪个面板。
// ② 恢复动作：原实现一旦 trip 就永久停在 fallback，只能刷新整页。补「重试该区域」
//    （清状态重渲染子树）与「重新加载应用」。
// ③ `overlay`：弹窗层的边界不占据可视位置（Radix 内容在 portal 里），
//    就地渲染会被壳层的 `overflow-hidden` 裁掉 ⇒ 那一处改成浮在底部的横幅。
// 语域沿用 #124 定的口径：书面语、不写 markdown 反引号（界面按纯文本渲染）。
import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  children: ReactNode;
  fallback?: ReactNode;
  /** 出错的区域名，如「工作区」「弹窗」；会出现在提示第一行 */
  label?: string;
  /** 浮在底部的横幅样式：给"就地没有可视位置"的挂载点（弹窗层）用 */
  overlay?: boolean;
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
        label: this.props.label,
      };
    }
  }

  /** 清状态重渲染子树：一次性故障（如热更新中间态）不必刷新整页就能恢复 */
  private retry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    const { label, overlay } = this.props;
    return (
      <div
        data-testid="error-boundary"
        data-overlay={overlay ? "true" : "false"}
        className={cn(
          "flex w-full items-center justify-center p-4",
          overlay
            ? "fixed inset-x-0 bottom-14 z-[100]"
            : "h-full min-h-[6rem]",
        )}
      >
        <div className="max-w-lg space-y-2 rounded-md border border-border/60 bg-card p-4 text-center shadow-md">
          <p className="text-sm font-medium">
            {label ? `${label}渲染出错` : "界面渲染出错"}
          </p>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            该区域已隔离，其余界面仍可正常使用。可重试该区域，或重新加载应用。
          </p>
          <p className="break-words text-[11px] text-muted-foreground/70">
            {this.state.error?.message ?? "未知错误"}
          </p>
          <div className="flex justify-center gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={this.retry}>
              重试{label ?? "该区域"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.location.reload()}
            >
              重新加载应用
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
