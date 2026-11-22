import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const editor = read("src/settings/sections/EditorSection.tsx");
const general = read("src/settings/sections/GeneralSection.tsx");
const agents = read("src/settings/sections/AgentsSection.tsx");
const models = read("src/settings/sections/ModelsSection.tsx");
const predictionHistory = read(
  "src/settings/sections/PredictionHistorySection.tsx",
);
const store = read("src/modules/settings/store.ts");

function expectControlledSetting(
  source: string,
  key: string,
  setter: string,
  control: "Switch" | "Select" | "Input",
) {
  expect(source).toContain(`s) => s.${key}`);
  expect(source).toContain(control);
  expect(source).toMatch(
    new RegExp(
      String.raw`on(?:CheckedChange|ValueChange|Change)=\{[\s\S]{0,240}\b${setter}\(`,
    ),
  );
}

describe("settings ownership", () => {
  it("keeps editor settings controlled by EditorSection only", () => {
    const editorSettings = [
      ["editorFontSize", "setEditorFontSize", "Select"],
      ["editorWordWrap", "setEditorWordWrap", "Switch"],
      ["vimMode", "setVimMode", "Switch"],
      ["editorAutoSave", "setEditorAutoSave", "Switch"],
      ["editorAutoSaveDelay", "setEditorAutoSaveDelay", "Input"],
      ["editorFormatOnSave", "setEditorFormatOnSave", "Switch"],
      ["editorCustomFormatCommand", "setEditorCustomFormatCommand", "Input"],
    ] as const;

    for (const [key, setter, control] of editorSettings) {
      expectControlledSetting(editor, key, setter, control);
      expect(general).not.toContain(key);
      expect(general).not.toContain(setter);
    }
  });

  it("keeps agent notifications in AgentsSection, not GeneralSection", () => {
    expectControlledSetting(
      agents,
      "agentNotifications",
      "setAgentNotifications",
      "Switch",
    );
    expect(general).not.toContain("agentNotifications");
    expect(general).not.toContain("setAgentNotifications");
  });

  it("keeps autocomplete trigger in ModelsSection, not GeneralSection", () => {
    expectControlledSetting(
      models,
      "autocompleteTrigger",
      "setAutocompleteTrigger",
      "Select",
    );
    expect(general).not.toContain("autocompleteTrigger");
    expect(general).not.toContain("setAutocompleteTrigger");
  });

  it("keeps remote Carapace controls in PredictionHistorySection", () => {
    expect(predictionHistory).toContain(
      'import { RemoteCarapaceCard } from "./RemoteCarapaceCard"',
    );
    expect(predictionHistory).toContain("<RemoteCarapaceCard />");
    expectControlledSetting(
      predictionHistory,
      "sshRemoteCarapacePrompt",
      "setSshRemoteCarapacePrompt",
      "Switch",
    );
    expect(general).not.toContain("RemoteCarapaceCard");
    expect(general).not.toContain("sshRemoteCarapacePrompt");
    expect(general).not.toContain("setSshRemoteCarapacePrompt");
  });

  it("does not show restore-window state in General or workspace defaults in Agents", () => {
    expect(general).not.toContain("restoreWindowState");
    expect(agents).not.toContain("defaultWorkspaceEnv");
    expect(agents).not.toContain("setDefaultWorkspaceEnv");
  });

  it("preserves the persisted keys and store read/write paths", () => {
    const persistedKeys = [
      ["KEY_EDITOR_FONT_SIZE", "editorFontSize"],
      ["KEY_EDITOR_WORD_WRAP", "editorWordWrap"],
      ["KEY_VIM_MODE", "vimMode"],
      ["KEY_EDITOR_AUTO_SAVE", "editorAutoSave"],
      ["KEY_EDITOR_AUTO_SAVE_DELAY", "editorAutoSaveDelay"],
      ["KEY_EDITOR_FORMAT_ON_SAVE", "editorFormatOnSave"],
      ["KEY_EDITOR_CUSTOM_FORMAT_COMMAND", "editorCustomFormatCommand"],
      ["KEY_AGENT_NOTIFICATIONS", "agentNotifications"],
      ["KEY_AUTOCOMPLETE_TRIGGER", "autocompleteTrigger"],
      ["KEY_SSH_REMOTE_CARAPACE_PROMPT", "sshRemoteCarapacePrompt"],
    ] as const;

    for (const [constant, key] of persistedKeys) {
      expect(store).toContain(`const ${constant} = "${key}"`);
      expect(store).toMatch(new RegExp(String.raw`get<[^>]+>\(${constant}\)`));
      expect(store).toMatch(new RegExp(String.raw`writePref\(${constant}`));
    }
  });
});
