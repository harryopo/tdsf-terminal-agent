// ============================================================================
// AgentCapabilityMatrix — 9 个子 Agent 能力矩阵（v2026-07-29 新增）
// ============================================================================
//
// 用途：在 Agent 面板的对话区下方展示"我能做什么"，让用户清楚知道
// 这个统一主 Agent 能自动路由到哪些子 Agent、每个子 Agent 擅长什么、
// 什么关键词会触发它。
//
// 设计要点（Terax 风格）：
//   - 默认折叠（不打扰当前对话）
//   - 用户点击 "我的能力" 展开 9 行能力卡片
//   - 每个 Agent 卡片：彩色图标 + 中英文标签 + 描述 + 触发关键词
//   - 颜色编码与 AgentStatusPill 一致（emerald=编码 / sky=探索 / ...）
//
// 9 个 Agent：
//   - Main       统一主 Agent（PAOR 监督 + 智能路由）
//   - Coding     代码生成与重构
//   - Explore    代码库扫描与索引
//   - History    命令历史与回放
//   - Teach      Linux 运维教学
//   - Debug      根因排查
//   - Refactor   代码重构
//   - Test       测试生成与运行
//   - Deploy     部署编排
// ============================================================================

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  ArrowRight01Icon,
  BookOpenIcon,
  CodeIcon,
  CommandIcon,
  HistoryIcon,
  PaintBrushIcon,
  RocketIcon,
  SparklesIcon,
  TestTubeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

type AgentMeta = {
  name: string;
  label: string;
  desc: string;
  icon: typeof CodeIcon;
  color: string; // text-* class
  bgColor: string; // bg-* /10 class for tag background
  keywords: string[];
};

const AGENT_MATRIX: AgentMeta[] = [
  {
    name: "main",
    label: "Main · 统一主 Agent",
    desc: "PAOR 监督循环，根据你的意图自动路由到 8 个子 Agent。你只需要说话，不用选 Agent。",
    icon: SparklesIcon,
    color: "text-foreground",
    bgColor: "bg-foreground/10",
    keywords: ["（统一入口，自动路由）"],
  },
  {
    name: "coding",
    label: "Coding · 代码生成与重构",
    desc: "编写、修改、重构代码，修复 Bug，生成代码骨架。调用 risk / decision 工具评估方案。",
    icon: CodeIcon,
    color: "text-emerald-500",
    bgColor: "bg-emerald-500/10",
    keywords: [
      "代码",
      "修改",
      "编辑",
      "写",
      "实现",
      "code",
      "edit",
      "write",
      "implement",
      "fix",
      "repair",
    ],
  },
  {
    name: "explore",
    label: "Explore · 代码库扫描",
    desc: "只读分析代码库架构、追踪调用链、定位文件、生成索引。不修改任何文件。",
    icon: CommandIcon,
    color: "text-sky-500",
    bgColor: "bg-sky-500/10",
    keywords: ["查找", "搜索", "查", "找", "定位", "search", "find", "locate"],
  },
  {
    name: "history",
    label: "History · 命令历史",
    desc: "检索过往会话、命令历史、错误模式，辅助复盘与教学。",
    icon: HistoryIcon,
    color: "text-amber-500",
    bgColor: "bg-amber-500/10",
    keywords: ["历史", "上次", "之前", "history", "previous", "last"],
  },
  {
    name: "teach",
    label: "Teach · 教学讲解",
    desc: "基于知识库 + tldr-pages 解释 Linux 命令原理，给出易错点与考点。支持 CET-4 词汇标注。",
    icon: BookOpenIcon,
    color: "text-violet-500",
    bgColor: "bg-violet-500/10",
    keywords: [
      "解释",
      "讲解",
      "教学",
      "什么是",
      "怎么用",
      "explain",
      "teach",
      "what is",
      "how to",
    ],
  },
  {
    name: "debug",
    label: "Debug · 根因排查",
    desc: "分析错误日志、定位故障根因、生成诊断报告。结合 risk 工具评估影响范围。",
    icon: CommandIcon,
    color: "text-rose-500",
    bgColor: "bg-rose-500/10",
    keywords: [
      "排查",
      "根因",
      "诊断",
      "调试",
      "debug",
      "diagnose",
      "root cause",
      "troubleshoot",
    ],
  },
  {
    name: "refactor",
    label: "Refactor · 代码重构",
    desc: "提取函数、内联变量、简化条件、模块拆分。在不改变行为的前提下改进代码结构。",
    icon: PaintBrushIcon,
    color: "text-cyan-500",
    bgColor: "bg-cyan-500/10",
    keywords: [
      "重构",
      "拆分",
      "提取",
      "内联",
      "简化",
      "refactor",
      "extract",
      "inline",
      "simplify",
    ],
  },
  {
    name: "test",
    label: "Test · 测试生成",
    desc: "根据代码生成单元测试、集成测试，运行测试套件，统计覆盖率。",
    icon: TestTubeIcon,
    color: "text-lime-500",
    bgColor: "bg-lime-500/10",
    keywords: [
      "测试",
      "单元测试",
      "集成测试",
      "验证",
      "test",
      "unit test",
      "integration",
      "coverage",
    ],
  },
  {
    name: "deploy",
    label: "Deploy · 部署编排",
    desc: "构建、发布、回滚、灰度发布，结合 SSH Agent 在远程服务器执行部署命令。",
    icon: RocketIcon,
    color: "text-orange-500",
    bgColor: "bg-orange-500/10",
    keywords: [
      "部署",
      "发布",
      "上线",
      "deploy",
      "release",
      "publish",
      "rollout",
    ],
  },
];

export function AgentCapabilityMatrix() {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-t border-border/40 bg-muted/15"
    >
      <CollapsibleTrigger
        className={cn(
          "group/cap flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px]",
          "transition-colors hover:bg-muted/40",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={10}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            "group-data-[state=open]/cap:rotate-90",
          )}
        />
        <HugeiconsIcon
          icon={SparklesIcon}
          size={11}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">我的能力</span>
        <span className="ml-1 text-[10.5px] text-muted-foreground">
          · 9 个 Agent · 自动路由
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "border-t border-border/30",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0",
        )}
      >
        <div className="flex flex-col gap-1.5 p-2.5">
          {AGENT_MATRIX.map((a) => (
            <AgentCard key={a.name} agent={a} />
          ))}
          <div className="mt-1 flex items-start gap-1.5 rounded-md bg-muted/30 px-2 py-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
            <HugeiconsIcon
              icon={SparklesIcon}
              size={10}
              strokeWidth={1.75}
              className="mt-0.5 shrink-0"
            />
            <span>
              <span className="font-medium text-foreground">统一入口</span>
              ：你只需要正常说话，主 Agent
              会根据关键词和上下文自动选择最合适的子 Agent。
            </span>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function AgentCard({ agent }: { agent: AgentMeta }) {
  return (
    <div
      className={cn(
        "group/agent flex items-start gap-2 rounded-md border border-border/40 bg-card/60 px-2 py-1.5",
        "transition-colors hover:border-border/70 hover:bg-card/80",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md",
          agent.bgColor,
        )}
      >
        <HugeiconsIcon
          icon={agent.icon}
          size={11}
          strokeWidth={1.75}
          className={agent.color}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn("text-[11.5px] font-semibold", agent.color)}>
            {agent.label}
          </span>
        </div>
        <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
          {agent.desc}
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {agent.keywords.slice(0, 4).map((kw) => (
            <span
              key={kw}
              className={cn(
                "rounded-sm border border-border/30 bg-background/60 px-1 py-0.5 font-mono text-[9.5px] text-muted-foreground",
              )}
            >
              {kw}
            </span>
          ))}
          {agent.keywords.length > 4 ? (
            <span className="px-1 py-0.5 text-[9.5px] text-muted-foreground/70">
              +{agent.keywords.length - 4}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
