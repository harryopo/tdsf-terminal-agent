import { Button } from "@/components/ui/button";
import { useUpdater } from "@/modules/updater";
import { GithubIcon, Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getName, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { arch, platform } from "@tauri-apps/plugin-os";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

// TDSF 魔改: 链接更新为 TDSF 仓库（原 terax-ai 上游链接保留在注释中供溯源）
// const UPSTREAM_REPO = "https://github.com/crynta/terax-ai";
// const UPSTREAM_WEBSITE = "https://terax.app";
const REPO_URL = "https://github.com/tdsf-linux-desktop/tdsf-terminal-agent";
const WEBSITE =
  "https://github.com/tdsf-linux-desktop/tdsf-terminal-agent#readme";

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
  const { status, check, install } = useUpdater({ autoCheck: false });
  const checking = status.kind === "checking";
  const downloading = status.kind === "downloading";
  const available = status.kind === "available";
  const manualAvailable = status.kind === "manual-available";
  const ready = status.kind === "ready";
  const checkLabel =
    status.kind === "uptodate"
      ? "已是最新版本"
      : status.kind === "error"
        ? "检查失败 — 重试"
        : checking
          ? "检查中…"
          : downloading
            ? "下载中…"
            : ready
              ? "重启以安装"
              : available
                ? `安装 v${status.update.version}`
                : manualAvailable
                  ? `更新到 v${status.info.version}`
                  : "检查更新";
  const onUpdateClick = () => {
    if (available) void install();
    else void check({ manual: true });
  };

  useEffect(() => {
    void getVersion().then(setVersion);
    void getName().then(setName);
    try {
      const p = platform();
      const a = arch();
      const platformLabel = PLATFORM_LABEL[p] ?? p;
      setBuild(`${platformLabel} · ${a}`);
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
            AI 原生 Linux 运维终端 · 高危命令拦截 · 教学辅助
          </span>
          <span className="mt-1 font-mono text-[11px] text-muted-foreground">
            v{version || "—"}
          </span>
        </div>
      </div>

      <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 text-[12px]">
        <dt className="text-muted-foreground">构建</dt>
        <dd className="font-mono text-[11.5px]">
          {build ? `${build} · v${version}` : `v${version}`}
        </dd>

        <dt className="text-muted-foreground">包 ID</dt>
        <dd className="font-mono text-[11.5px]">com.tdsf.terminal-agent</dd>

        <dt className="text-muted-foreground">许可证</dt>
        <dd>Apache 2.0</dd>

        <dt className="text-muted-foreground">源代码</dt>
        <dd>
          <button
            type="button"
            onClick={() => void openUrl(REPO_URL)}
            className="inline-flex items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:text-foreground hover:underline"
          >
            <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />
            tdsf-linux-desktop/tdsf-terminal-agent
          </button>
        </dd>
        <dt className="text-muted-foreground">网站</dt>
        <dd>
          <button
            type="button"
            onClick={() => void openUrl(WEBSITE)}
            className="inline-flex items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:text-foreground hover:underline"
          >
            <HugeiconsIcon icon={Globe02Icon} size={12} strokeWidth={1.75} />
            TDSF 项目主页（GitHub README）
          </button>
        </dd>
      </dl>

      <div className="flex flex-col gap-1.5">
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={onUpdateClick}
            disabled={checking || downloading || ready}
          >
            {checkLabel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void openUrl(REPO_URL)}
            className="gap-1.5"
          >
            <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />在
            GitHub 上查看
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void openUrl(`${REPO_URL}/issues/new`)}
          >
            报告问题
          </Button>
        </div>
        {status.kind === "error" && (
          <p className="font-mono text-[10.5px] break-all text-destructive/80">
            {status.message}
          </p>
        )}
        {downloading && status.contentLength ? (
          <p className="text-[11px] text-muted-foreground">
            {Math.min(
              100,
              Math.round((status.downloaded / status.contentLength) * 100),
            )}
            %
          </p>
        ) : null}
      </div>
    </div>
  );
}
