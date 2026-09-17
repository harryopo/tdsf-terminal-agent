import { Button } from "@/components/ui/button";
import { GithubIcon, Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getName, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { arch, platform } from "@tauri-apps/plugin-os";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

const REPO_URL = "https://github.com/harryopo/tdsf-terminal-agent";
const WEBSITE = "https://github.com/harryopo/tdsf-terminal-agent#readme";

const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
  freebsd: "FreeBSD",
};

export function AboutSection() {
  const [version, setVersion] = useState("");
  const [name, setName] = useState("TDSF Terminal Agent");
  const [build, setBuild] = useState("");

  useEffect(() => {
    void getVersion().then(setVersion);
    void getName().then(setName);
    try {
      const p = platform();
      const a = arch();
      setBuild(`${PLATFORM_LABEL[p] ?? p} · ${a}`);
    } catch {
      setBuild("");
    }
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title="关于" description="" />

      <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-card/60 p-5">
        <img
          src="/logo.svg"
          alt=""
          className="size-12 rounded-lg"
          draggable={false}
        />
        <div className="flex min-w-0 flex-col">
          <span className="text-[15px] font-semibold tracking-tight">
            {name}
          </span>
          <span className="text-[11px] text-muted-foreground">
            AI 原生 Linux 运维终端 · 可见执行 · 交互教学
          </span>
          <span className="mt-1 font-mono text-[11px] text-muted-foreground">
            v{version || "—"}
          </span>
        </div>
      </div>

      <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 text-[13px]">
        <dt className="text-muted-foreground">构建</dt>
        <dd className="font-mono text-[13px]">
          {build ? `${build} · v${version}` : `v${version}`}
        </dd>
        <dt className="text-muted-foreground">应用 ID</dt>
        <dd className="font-mono text-[13px]">com.tdsf.terminal-agent</dd>
        <dt className="text-muted-foreground">许可证</dt>
        <dd>Apache 2.0</dd>
        <dt className="text-muted-foreground">源代码</dt>
        <dd>
          <button
            type="button"
            onClick={() => void openUrl(REPO_URL)}
            className="inline-flex items-center gap-1.5 rounded-md text-[13px] underline-offset-2 hover:text-foreground hover:underline"
          >
            <HugeiconsIcon icon={GithubIcon} size={13} strokeWidth={1.75} />
            harryopo/tdsf-terminal-agent
          </button>
        </dd>
        <dt className="text-muted-foreground">网站</dt>
        <dd>
          <button
            type="button"
            onClick={() => void openUrl(WEBSITE)}
            className="inline-flex items-center gap-1.5 rounded-md text-[13px] underline-offset-2 hover:text-foreground hover:underline"
          >
            <HugeiconsIcon icon={Globe02Icon} size={13} strokeWidth={1.75} />
            TDSF 项目主页
          </button>
        </dd>
      </dl>

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-3 text-xs"
          onClick={() => void openUrl(REPO_URL)}
        >
          <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />
          在 GitHub 上查看
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={() => void openUrl(`${REPO_URL}/issues/new`)}
        >
          报告问题
        </Button>
      </div>
    </div>
  );
}
