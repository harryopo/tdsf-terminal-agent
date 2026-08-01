/**
 * teachParser.ts — teach 教学输出解析（P2-1）
 * -----------------------------------------------------------------------------
 * teach 子 agent 输出结构化 markdown（6 大板块教学法）：
 *   💡 概念与原理 / 📂 路径拆解 / 🏛️ Linux 设计哲学 /
 *   📝 操作示例 / ⚠️ 易错点与考点 / ✏️ 练习
 * 本模块负责：教学格式检测 + markdown 分节解析（纯函数，与 UI 分离）。
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

// 板块 emoji（逐字 startsWith 匹配，避免代理对正则问题）
const EMOJI_TYPES: Array<[string, TeachSectionType]> = [
  ["💡", "concept"],
  ["📂", "path"],
  ["🏛️", "philosophy"],
  ["📝", "example"],
  ["⚠️", "pitfall"],
  ["✏️", "exercise"],
];

// 标题关键词 → 板块（detectSectionType 收到的是剥离 # 后的标题）
const KEYWORD_TYPES: Array<[RegExp, TeachSectionType]> = [
  [/概念|原理/i, "concept"],
  [/路径拆解/i, "path"],
  [/设计哲学|哲学/i, "philosophy"],
  [/示例/i, "example"],
  [/易错/i, "pitfall"],
  [/练习/i, "exercise"],
];

/** 判断消息是否为教学输出（teach 格式标记检测） */
export function isTeachMessage(text: string): boolean {
  if (!text) return false;
  // 教学标题结构（## N. 概念/示例/易错/练习…）——短标题也识别
  if (/##\s*\d+\.\s*(概念|原理|路径|哲学|示例|易错|练习)/.test(text)) {
    return true;
  }
  // 6 大板块 emoji 标记（需有一定内容量，避免误判）
  if (text.length < 20) return false;
  return EMOJI_TYPES.some(([emoji]) => text.includes(emoji));
}

/** 解析教学 markdown → 分区列表 */
export function parseTeachSections(markdown: string): TeachSection[] {
  const lines = markdown.split("\n");
  const sections: TeachSection[] = [];
  let current: TeachSection | null = null;

  const flush = () => {
    if (current && (current.content.trim() || current.commands.length)) {
      sections.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    // 检测分节标题：## N. xxx 或 emoji 开头
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
      // 标题前的导语 → 归入 concept 前置段
      if (line.trim()) {
        current = { type: "concept", title: "概念与原理", content: "", commands: [] };
      } else {
        continue;
      }
    }
    current.content += line + "\n";
  }
  flush();

  // 提取代码块为 commands（供插入终端），并保留原 markdown
  for (const s of sections) {
    const re = /```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s.content)) !== null) {
      const cmd = m[1].trim();
      if (cmd && !cmd.includes("\n")) s.commands.push(cmd);
    }
  }
  return sections;
}

function detectSectionType(title: string): TeachSectionType {
  for (const [re, type] of KEYWORD_TYPES) {
    if (re.test(title)) return type;
  }
  return "other";
}
