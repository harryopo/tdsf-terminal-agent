import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { SearchAddon } from "@xterm/addon-search";
import { Fragment, useCallback, useEffect, type Ref } from "react";
import { setLeafSshSession } from "@/lib/param-complete-client";
import { SshCarapaceBadge } from "@/modules/ssh-explorer/SshCarapaceBadge";
import { SshIntegrationBadge } from "@/modules/ssh-explorer/SshIntegrationBadge";
import { useTerminalDropStore } from "./lib/dropStore";
import {
  effectiveLeafSsh,
  firstLeafSlotId,
  type PaneNode,
} from "./lib/panes";
import { useSshLeafTransport } from "./lib/useSshLeafTransport";
import { isSessionConnecting, useSshStore } from "@/modules/ssh-explorer/sshStore";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";

type LeafBundle = {
  setRef: (h: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
};

type Props = {
  node: PaneNode;
  tabVisible: boolean;
  activeLeafId: number;
  blocks: boolean;
  /** TDSF (2026-08-11): 所在 tab 的 SSH 会话绑定，供 leaf 继承（undefined=本地 tab）。 */
  tabSshSessionId?: string | null;
  onFocusLeaf: (leafId: number) => void;
  getBundle: (leafId: number) => LeafBundle;
};

export function PaneTreeView(props: Props) {
  const { node } = props;
  if (node.kind === "leaf") {
    const {
      tabVisible,
      activeLeafId,
      blocks,
      tabSshSessionId,
      onFocusLeaf,
      getBundle,
    } = props;
    const focused = node.id === activeLeafId;
    const b = getBundle(node.id);
    // TDSF (2026-08-11): 计算本 leaf 的有效 SSH 会话。
    // leaf 显式绑定优先，否则继承 tab 绑定；返回 string 才走 SSH 渲染。
    const effectiveSsh = effectiveLeafSsh(node, node.id, tabSshSessionId);
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: pane container that captures mousedown for focus management; not a semantic button.
      <div
        onMouseDownCapture={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        // Catches focus from Tab, programmatic focus, or any path that
        // skips mousedown — keeps activeLeafId in sync with DOM focus.
        onFocus={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        data-pane-leaf={node.id}
        className="relative h-full w-full"
      >
        <TerminalPaneContent
          leafId={node.id}
          visible={tabVisible}
          focused={focused}
          initialCwd={node.cwd}
          blocks={blocks}
          effectiveSsh={effectiveSsh}
          ref={b.setRef}
          onSearchReady={b.onSearchReady}
          onCwd={b.onCwd}
          onExit={b.onExit}
        />
        <DropOverlay leafId={node.id} />
      </div>
    );
  }

  return (
    <ResizablePanelGroup
      orientation={node.dir === "row" ? "horizontal" : "vertical"}
    >
      {node.children.map((child, i) => {
        const slotId = firstLeafSlotId(child);
        return (
          <Fragment key={slotId}>
            {i > 0 && <ResizableHandle />}
            <ResizablePanel id={`pane-slot-${slotId}`} minSize="10%">
              <PaneTreeView {...props} node={child} />
            </ResizablePanel>
          </Fragment>
        );
      })}
    </ResizablePanelGroup>
  );
}

type PaneProps = {
  /** React 19 ref-as-prop：透传给 TerminalPane（SSH/本地同路径注册 handle）。 */
  ref?: Ref<TerminalPaneHandle>;
  leafId: number;
  visible: boolean;
  focused: boolean;
  initialCwd?: string;
  blocks: boolean;
  onSearchReady?: (leafId: number, addon: SearchAddon) => void;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string) => void;
};

/**
 * leaf 内容分发：已连接或持有匹配 handle 的重连阶段保留 SSH 叶子，
 * 避免短暂状态变化替换传输并清掉远端补全绑定；**最终断开/会话被移除时渲染
 * 离线占位，不回退本地 TerminalPane**（S0：否则会在 SSH 标签页里隐式创建本地 PTY）。
 * 首次连接/无匹配 handle 的过渡态维持原"本地保活"行为。
 * 拆成子组件是为了满足 hook 规则：useSshStore 每次渲染都调用，
 * 条件渲染的是子组件而非 hook。
 */
type PaneRenderMode = "local" | "ssh" | "offline";

function TerminalPaneContent({
  effectiveSsh,
  ...paneProps
}: PaneProps & { effectiveSsh: string | null }) {
  const mode = useSshStore((s): PaneRenderMode => {
    if (!effectiveSsh) return "local";
    const session = s.sessions.find((it) => it.id === effectiveSsh);
    // 最终断开（closed/failed）或会话已从 store 移除：保留远端意图，只显示离线占位。
    if (!session) return "offline";
    if (session.state === "closed" || session.state === "failed") return "offline";
    const usableSsh =
      session.state === "connected" ||
      (isSessionConnecting(session) &&
        session.rustSessionId != null &&
        session.handle?.id === session.rustSessionId);
    return usableSsh ? "ssh" : "local";
  });
  if (mode === "offline") {
    return <SshLeafOffline leafId={paneProps.leafId} />;
  }
  if (mode === "ssh" && effectiveSsh) {
    return <SshLeafPane sessionId={effectiveSsh} {...paneProps} />;
  }
  return <TerminalPane {...paneProps} />;
}

/**
 * S0（2026-11-12）：SSH 叶子的最终断开占位。
 * 绑定会话已结束/被移除时显示在这里 —— 不挂载 TerminalPane，因此不会创建本地 PTY；
 * 重新连接成功后会话恢复，同一个 leaf 会回到远端 shell。重连入口仍走工作区/左侧
 * 离线面板，本组件只负责状态呈现。
 */
function SshLeafOffline({ leafId }: { leafId: number }) {
  return (
    <div
      data-testid="pane-ssh-offline"
      data-offline-leaf={leafId}
      className="flex h-full w-full items-center justify-center px-6 text-center"
    >
      <div className="space-y-1">
        <div className="text-[13px] font-medium text-foreground">
          SSH 会话已断开
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          这里保留远端终端的位置；重新连接后会回到本标签页。
        </p>
      </div>
    </div>
  );
}

/**
 * TDSF (2026-08-11): SSH 叶子 —— 与 SshTerminalHost 同源 transport 注入，
 * 但 leafId 来自 paneTree（可多实例分屏），onCwd 同步远程 cwd 到 sshStore。
 */
function SshLeafPane({
  sessionId,
  leafId,
  ...paneProps
}: PaneProps & { sessionId: string }) {
  const { openTransport } = useSshLeafTransport(sessionId);
  // TDSF 2026-08-28: leaf ↔ SSH 会话注册——参数补全（completionInjection）经
  // 注册表把 rustSessionId 用于远端 carapace 查询（ssh_command exec 通道）。
  // 连接建立后 rustSessionId 才非空，此处响应式注册/注销。
  const rustSessionId = useSshStore(
    (s) => s.sessions.find((it) => it.id === sessionId)?.rustSessionId ?? null,
  );
  useEffect(() => {
    // 第 3 参：远端 cwd getter —— ssh_command exec 默认在远端 home 执行，
    // carapace 动态候选（git 分支等）需 cd 到 OSC 7 跟踪的当前目录
    setLeafSshSession(
      leafId,
      rustSessionId,
      () => useSshStore.getState().currentPathBySession[sessionId] ?? null,
    );
    return () => setLeafSshSession(leafId, null);
  }, [leafId, rustSessionId, sessionId]);
  // OSC 7 的远端 cwd 只写会话级那一份：leaf.cwd 槽位刻意留给本地 shell，
  // "这块 leaf 现在在哪"由 leafCwdOf 联合口径回答（见 lib/leafCwd.ts，#91①）。
  const handleCwd = useCallback(
    (_leafId: number, cwd: string) => {
      useSshStore.getState().setCurrentPath(sessionId, cwd);
    },
    [sessionId],
  );
  return (
    // 相对定位容器承载远端补全安装提示 badge（无弹窗设计，右下角小图标）
    <div className="relative h-full w-full">
      <TerminalPane
        {...paneProps}
        leafId={leafId}
        // 远端 shell 不一定有 OSC 133 shell integration，关闭 block 装饰
        blocks={false}
        openTransport={openTransport}
        transportKey={sessionId}
        remote
        onCwd={handleCwd}
      />
      <SshCarapaceBadge sessionId={sessionId} />
      <SshIntegrationBadge
        sessionId={sessionId}
        leafId={leafId}
        active={paneProps.visible && paneProps.focused}
      />
    </div>
  );
}

function DropOverlay({ leafId }: { leafId: number }) {
  const active = useTerminalDropStore((s) => s.targetLeafId === leafId);
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-lg border border-primary/45 bg-background/70 text-xs font-medium text-foreground shadow-lg backdrop-blur-sm">
      Drop file path here
    </div>
  );
}
