/**
 * 侧栏面板的懒边界（#94 §6-B）。
 *
 * 为什么要有这个文件：`SkillsPanel` / `SnippetsPanel` / `TunnelPanel` 此前被 `App.tsx`
 * **静态** import，于是整片面板连同它的对话框与 store 全进了首屏 eager 图 ——
 * 而它们只在用户点了侧栏那一格之后才需要。本仓对这个病早有做法
 * （`ai/components/lazy.tsx` + `KnowledgePanelLazy`），这条只是把它做完。
 *
 * 判据在 `src/app/eager-budget.test.ts`：负向钉"面板不在 eager 图里"，
 * 正向配对钉"懒边界仍然通向真面板"（少一条正向，整片删掉面板也能全绿）。
 * lazy 的包装只许写在这一处 —— App.tsx 里再手写一份就是第二个主人。
 */
import type { ComponentProps } from "react";
import { lazy, Suspense } from "react";

const SkillsPanelInner = lazy(() =>
  import("@/modules/skills").then((m) => ({ default: m.SkillsPanel })),
);

const SnippetsPanelInner = lazy(() =>
  import("@/modules/snippets").then((m) => ({ default: m.SnippetsPanel })),
);

const TunnelPanelInner = lazy(() =>
  import("@/modules/tunnels").then((m) => ({ default: m.TunnelPanel })),
);

// props 从那条动态 import 的结果里推，不再另抄一份签名
type SkillsPanelLazyProps = ComponentProps<typeof SkillsPanelInner>;
type SnippetsPanelLazyProps = ComponentProps<typeof SnippetsPanelInner>;
type TunnelPanelLazyProps = ComponentProps<typeof TunnelPanelInner>;

export function SkillsPanelLazy(props: SkillsPanelLazyProps) {
  return (
    <Suspense fallback={null}>
      <SkillsPanelInner {...props} />
    </Suspense>
  );
}

export function SnippetsPanelLazy(props: SnippetsPanelLazyProps) {
  return (
    <Suspense fallback={null}>
      <SnippetsPanelInner {...props} />
    </Suspense>
  );
}

export function TunnelPanelLazy(props: TunnelPanelLazyProps) {
  return (
    <Suspense fallback={null}>
      <TunnelPanelInner {...props} />
    </Suspense>
  );
}
