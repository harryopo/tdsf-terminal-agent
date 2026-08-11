import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { SearchAddon } from "@xterm/addon-search";
import { Fragment, useCallback, type Ref } from "react";
import { useTerminalDropStore } from "./lib/dropStore";
import {
  effectiveLeafSsh,
  firstLeafSlotId,
  type PaneNode,
} from "./lib/panes";
import { useSshLeafTransport } from "./lib/useSshLeafTransport";
import { getOsc7Log, useSshStore } from "@/modules/ssh-explorer/sshStore";
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
  /** TDSF 魔改 (2026-08-11): 所在 tab 的 SSH 会话绑定，供 leaf 继承（undefined=本地 tab）。 */
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
    // TDSF 魔改 (2026-08-11): 计算本 leaf 的有效 SSH 会话。
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
 * TDSF 魔改 (2026-08-11): leaf 内容分发 —— 有效 SSH 会话且会话仍 connected
 * 时渲染 SSH 叶子（复用 useSshLeafTransport 注入 openTransport），否则渲染本地
 * TerminalPane。拆成子组件是为了满足 hook 规则：useSshStore 每次渲染都调用，
 * 条件渲染的是子组件而非 hook。
 */
function TerminalPaneContent({
  effectiveSsh,
  ...paneProps
}: PaneProps & { effectiveSsh: string | null }) {
  // 响应式查询该会话是否仍 connected（连接状态变化时重渲染，断开自动回退本地）
  const sshConnected = useSshStore((s) =>
    effectiveSsh
      ? s.sessions.some(
          (it) => it.id === effectiveSsh && it.state === "connected",
        )
      : false,
  );
  if (effectiveSsh && sshConnected) {
    return <SshLeafPane sessionId={effectiveSsh} {...paneProps} />;
  }
  return <TerminalPane {...paneProps} />;
}

/**
 * TDSF 魔改 (2026-08-11): SSH 叶子 —— 与 SshTerminalHost 同源 transport 注入，
 * 但 leafId 来自 paneTree（可多实例分屏），onCwd 同步远程 cwd 到 sshStore。
 */
function SshLeafPane({
  sessionId,
  ...paneProps
}: PaneProps & { sessionId: string }) {
  const { openTransport } = useSshLeafTransport(sessionId);
  // SSH 终端 OSC 7 解析后同步远程 cwd（与 SshTerminalHost.handleCwd 一致）
  const handleCwd = useCallback(
    (_leafId: number, cwd: string) => {
      getOsc7Log()?.push({ source: "SshLeafPane.handleCwd", sessionId, cwd });
      useSshStore.getState().setCurrentPath(sessionId, cwd);
    },
    [sessionId],
  );
  return (
    <TerminalPane
      {...paneProps}
      // 远端 shell 不一定有 OSC 133 shell integration，关闭 block 装饰
      blocks={false}
      openTransport={openTransport}
      remote
      onCwd={handleCwd}
    />
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
