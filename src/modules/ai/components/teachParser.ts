/**
 * Teach output parser.
 *
 * Teaching is an output contract, not a visual guess.  In particular, a
 * knowledge-base report may contain headings such as “概念与原理” and must
 * remain an ordinary Markdown response.  The sidecar therefore adds the
 * invisible marker below only when the user actually requested instruction.
 */

export type TeachSectionType =
  | "concept"
  | "path"
  | "philosophy"
  | "example"
  | "pitfall"
  | "exercise"
  | "other";

export interface TeachSection {
  type: TeachSectionType;
  title: string;
  content: string;
  commands: string[];
}

/** First-line marker emitted by the teaching output contract. */
export const TEACH_OUTPUT_MARKER = "<!-- tdsf:teach -->";
const TEACH_OUTPUT_MARKER_RE = /^\s*<!--\s*tdsf:teach\s*-->\s*/i;

// Emoji markers are kept for parsing old, explicitly marked teaching output.
const EMOJI_TYPES: Array<[string, TeachSectionType]> = [
  ["🏛️", "concept"],
  ["🧭", "path"],
  ["⚖️", "philosophy"],
  ["🧪", "example"],
  ["⚠️", "pitfall"],
  ["📝", "exercise"],
];

const KEYWORD_TYPES: Array<[RegExp, TeachSectionType]> = [
  [/概念|原理/i, "concept"],
  [/路径|步骤|流程/i, "path"],
  [/命令哲学|教学/i, "philosophy"],
  [/操作|示例|示范/i, "example"],
  [/易错|注意|陷阱/i, "pitfall"],
  [/练习|实践/i, "exercise"],
];

// Models sometimes omit Markdown hashes while keeping the teaching labels.
// Recognize those labels only in Teach mode; ordinary Markdown remains safe.
const PLAIN_HEADING_RE =
  /^\s*(?:\*\*|__)?\s*(?:(?:\d+|[一二三四五六七八九十]+)[\s.、)．-]+)?(概念(?:与原理)?|原理|路径(?:拆解|解析)?|步骤|流程|Linux\s*设计哲学|命令哲学|操作(?:示例|示范)?|示例|示范|易错点?(?:与(?:考点|检查)|提示)?|注意事项|练习|实践练习)(?:\s*[:：—-]\s*(.*?))?\s*(?:\*\*|__)?\s*$/i;

/**
 * Return true for an explicitly marked teaching response, or a structurally
 * recognizable legacy teaching response when Teach mode is already enabled.
 *
 * The previous implementation inferred the mode from headings and emoji.
 * That made ordinary knowledge-search summaries turn into TeachCards.  A
 * A missing marker is still fail-closed outside Teach mode, so knowledge
 * reports and tool status cannot become lesson cards accidentally.
 */
export function isTeachMessage(text: string): boolean {
  return Boolean(text && TEACH_OUTPUT_MARKER_RE.test(text));
}

/** Remove the transport marker before ordinary Markdown rendering. */
export function stripTeachOutputMarker(text: string): string {
  return text.replace(TEACH_OUTPUT_MARKER_RE, "");
}

/**
 * A TeachCard parses section boundaries and fenced commands.  It must only
 * receive a completed response: a max-token continuation can otherwise leave
 * an unclosed fence or a half section in the live stream.
 */
export function shouldRenderTeachCard(
  text: string,
  teachEnabled: boolean,
  streaming: boolean,
): boolean {
  if (!teachEnabled || !text.trim()) return false;
  // The explicit transport marker is authoritative and may be rendered while
  // tokens are still arriving, so the lesson card does not disappear during
  // a live response.
  if (isTeachMessage(text)) return true;
  if (streaming) return false;
  // Compatibility with older sidecars that emitted teaching labels without
  // the marker. Require two distinct lesson sections so a knowledge document
  // that happens to mention one “示例” heading stays ordinary Markdown.
  const types = new Set(
    parseTeachSections(text)
      .map((section) => section.type)
      .filter((type) => type !== "other"),
  );
  return types.size >= 2;
}

/** Parse a marked teaching response into the small set of UI sections. */
export function parseTeachSections(markdown: string): TeachSection[] {
  const lines = markdown.replace(TEACH_OUTPUT_MARKER_RE, "").split("\n");
  const sections: TeachSection[] = [];
  let current: TeachSection | null = null;

  const flush = () => {
    if (current) sections.push(current);
    current = null;
  };

  for (const line of lines) {
    const headerMatch = line.match(/^\s*#{1,4}\s*(.*)$/);
    let isHeader = false;
    let title = "";
    let forcedType: TeachSectionType | null = null;

    if (headerMatch) {
      title = headerMatch[1].trim();
      isHeader = title.length > 0;
    } else {
      const trimmed = line.trimStart();
      for (const [emoji, type] of EMOJI_TYPES) {
        if (trimmed.startsWith(emoji)) {
          title = trimmed.slice(emoji.length).trim();
          isHeader = true;
          forcedType = type;
          break;
        }
      }

      if (!isHeader) {
        const plainHeading = line.match(PLAIN_HEADING_RE);
        if (plainHeading) {
          const label = plainHeading[1].trim();
          const suffix = plainHeading[2]?.trim();
          title = suffix ? `${label}：${suffix}` : label;
          isHeader = true;
          forcedType = detectSectionType(label);
        }
      }
    }

    if (isHeader) {
      flush();
      current = {
        type: forcedType ?? detectSectionType(title),
        title,
        content: "",
        commands: [],
      };
      continue;
    }

    if (!current) {
      // A preface is useful only when the response is already explicitly
      // marked as teaching; it is not a signal by itself.
      if (line.trim()) {
        current = { type: "other", title: "说明", content: "", commands: [] };
      } else {
        continue;
      }
    }
    current.content += line + "\n";
  }
  flush();

  return sections
    .map((section) => normalizeSection(section))
    .filter(
      (section) =>
        section.content.trim().length > 0 || section.commands.length > 0,
    );
}

// A one-line shell fence is an executable teaching command.  A multi-line
// fence remains explanatory Markdown (no Run/Insert affordance), and an empty
// fence is removed altogether so the UI never invents an empty “$” command.
const SHELL_FENCE_RE =
  /```([\t ]*(?:bash|sh|shell|zsh)[\t ]*)\n([\s\S]*?)```/gi;

function normalizeSection(section: TeachSection): TeachSection {
  const commands = [...section.commands];
  const content = section.content.replace(
    SHELL_FENCE_RE,
    (_whole, _language: string, body: string) => {
      const lines = body
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length === 0) return "";
      if (lines.length === 1) {
        const command = lines[0].replace(/^\$\s+/, "");
        if (command) commands.push(command);
        return "";
      }
      return _whole;
    },
  );

  return {
    ...section,
    content: content.replace(/\n{3,}/g, "\n\n").trim(),
    commands: [...new Set(commands)],
  };
}

function detectSectionType(title: string): TeachSectionType {
  for (const [re, type] of KEYWORD_TYPES) {
    if (re.test(title)) return type;
  }
  return "other";
}
