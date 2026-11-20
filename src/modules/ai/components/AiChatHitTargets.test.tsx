import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const composer = vi.hoisted(() => ({
  value: "",
  setValue: vi.fn(),
  submit: vi.fn(),
  stop: vi.fn(),
  canSend: true,
  isBusy: false,
  textareaRef: { current: null as HTMLTextAreaElement | null },
}));

vi.mock("../lib/composer", () => ({ useComposer: () => composer }));
vi.mock("../store/chatStore", () => ({
  useChatStore: (selector: (state: { live: object }) => unknown) =>
    selector({ live: { getWorkspaceRoot: () => null, getSshRustSessionId: () => null } }),
}));
vi.mock("../store/snippetsStore", () => ({
  useSnippetsStore: (selector: (state: { snippets: never[] }) => unknown) =>
    selector({ snippets: [] }),
}));
vi.mock("@/modules/skills/skillsStore", () => ({
  useSkillsStore: (selector: (state: { skills: never[]; loaded: boolean; loadAll: () => void }) => unknown) =>
    selector({ skills: [], loaded: true, loadAll: vi.fn() }),
}));
vi.mock("../hooks/useWorkspaceFiles", () => ({
  useWorkspaceFiles: () => ({ files: [], indexing: false, truncated: false }),
}));
vi.mock("../hooks/useRemoteWorkspaceFiles", () => ({
  useRemoteWorkspaceFiles: () => ({ files: [], indexing: false, truncated: false, error: null }),
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./FilePicker", () => ({ FilePickerContent: () => null }));
vi.mock("./SnippetPicker", () => ({ SnippetPickerContent: () => null }));

import { AiComposerInput } from "./AiComposerInput";

const componentSource = (name: string) =>
  readFileSync(join(import.meta.dirname, name), "utf8");

function jsxAttribute(node: ts.JsxOpeningLikeElement, name: string) {
  return node.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  )?.initializer;
}

function stringAttribute(node: ts.JsxOpeningLikeElement, name: string) {
  const initializer = jsxAttribute(node, name);
  return initializer && ts.isStringLiteral(initializer) ? initializer.text : null;
}

function jsxElements(source: string) {
  const file = ts.createSourceFile("component.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: ts.JsxOpeningLikeElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function classTokens(node: ts.JsxOpeningLikeElement) {
  const initializer = jsxAttribute(node, "className");
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer)) return initializer.text.split(/\s+/);
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return [];
  const tokens: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isStringLiteral(child)) tokens.push(...child.text.split(/\s+/));
    ts.forEachChild(child, visit);
  };
  visit(initializer.expression);
  return tokens;
}

function renderComposer(overrides: Partial<typeof composer> = {}) {
  Object.assign(composer, {
    value: "",
    setValue: vi.fn(),
    submit: vi.fn(),
    stop: vi.fn(),
    canSend: true,
    isBusy: false,
    ...overrides,
  });
  return render(<AiComposerInput />);
}

beforeEach(() => {
  composer.textareaRef.current = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AI chat hit targets and composer behavior", () => {
  it("keeps the mini-window close button at the 28px hit-target size", () => {
    const nodes = jsxElements(componentSource("AiMiniWindow.tsx")).filter(
      (node) => node.tagName.getText() === "Button" && stringAttribute(node, "aria-label") === "关闭",
    );
    expect(nodes).toHaveLength(1);
    expect(stringAttribute(nodes[0], "className")?.split(/\s+/)).toContain("size-7");
  });

  it("keeps the composer textarea at a 28px minimum height", () => {
    const nodes = jsxElements(componentSource("AiComposerInput.tsx")).filter(
      (node) => node.tagName.getText() === "textarea",
    );
    expect(nodes).toHaveLength(1);
    expect(classTokens(nodes[0])).toContain("min-h-7");
  });

  it("submits on Enter", () => {
    renderComposer();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: false });
    expect(composer.submit).toHaveBeenCalledTimes(1);
  });

  it("does not submit on Shift+Enter", () => {
    renderComposer();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: true });
    expect(composer.submit).not.toHaveBeenCalled();
  });

  it("shows a clickable stop control while busy", () => {
    renderComposer({ isBusy: true });
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
    expect(composer.stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });

  it("disables sending when the composer cannot send", () => {
    renderComposer({ canSend: false });
    expect(
      (screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("caps textarea autoresize at the existing 160px limit", () => {
    const original = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "scrollHeight",
    );
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 300,
    });
    try {
      renderComposer();
      const textarea = screen.getByRole("textbox");
      expect((textarea as HTMLTextAreaElement).style.height).toBe("160px");
    } finally {
      if (original) {
        Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", original);
      } else {
        Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight");
      }
    }
  });
});
