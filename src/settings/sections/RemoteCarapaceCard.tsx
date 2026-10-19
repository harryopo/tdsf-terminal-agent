/**
 * RemoteCarapaceCard.tsx — 设置页里能真点开的「远端补全组件」入口
 * -----------------------------------------------------------------------------
 * 原来这条链路只有一个入口：SSH 终端右下角 16px 小图标（用户 2026-09-28 反馈
 * 「我从来不知道有这回事」，且装失败只在小图标里说一句）。这里给一个不依赖
 * 恰好看见图标的入口：列出正连着的服务器、每台什么状态、点一下就装、失败把
 * 原因原文摆出来。
 *
 * 逻辑全在 `remoteCarapaceAdmin`（可离线测），本文件只管渲染。
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CarapaceInstallStage } from "@/lib/param-complete-client";
import {
  CARAPACE_BINARY_MB,
  installCarapaceTarget,
  listCarapaceTargets,
  probeCarapaceTarget,
  type CarapaceProbeResult,
  type CarapaceTarget,
} from "@/settings/lib/remoteCarapaceAdmin";

interface RowState {
  /** null = 还在检测 */
  probe: CarapaceProbeResult | null;
  installing: boolean;
  stage: CarapaceInstallStage | null;
  message: string | null;
  /** 正在装这台时失败的原因 */
  error: string | null;
}

const EMPTY_ROW: RowState = {
  probe: null,
  installing: false,
  stage: null,
  message: null,
  error: null,
};

/** 安装阶段 → 界面文案（上传那一档把体积写进去，用户要知道在等什么） */
const STAGE_TEXT: Record<CarapaceInstallStage, string> = {
  preparing: "准备中：在服务器建目录…",
  uploading: `上传中：约 ${CARAPACE_BINARY_MB} MB，只装一次…`,
  configuring: "配置中：设为可执行并验证…",
  done: "完成：远端参数补全已启用",
};

function statusText(row: RowState): string {
  if (row.installing) return row.stage ? STAGE_TEXT[row.stage] : "安装中…";
  if (!row.probe) return "检测中…";
  if (row.probe.state === "installed") return "已安装";
  if (row.probe.state === "missing") return "未安装";
  return `检测不出来：${row.probe.detail ?? "没有返回原因"}`;
}

export function RemoteCarapaceCard() {
  const [targets, setTargets] = useState<CarapaceTarget[]>([]);
  const [rows, setRows] = useState<Record<number, RowState>>({});
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [queried, setQueried] = useState(false);
  const generation = useRef(0);
  const refreshing = useRef(false);
  const installing = useRef(new Set<number>());

  useEffect(() => () => { generation.current += 1; }, []);

  const patch = (id: number, next: Partial<RowState>, version: number) => {
    if (version !== generation.current) return;
    setRows((prev) => version === generation.current
      ? { ...prev, [id]: { ...nextRow(prev, id), ...next } }
      : prev);
  };

  const refresh = async () => {
    if (refreshing.current || installing.current.size > 0) return;
    refreshing.current = true;
    const version = ++generation.current;
    setLoading(true);
    setListError(null);
    const { targets: found, error } = await listCarapaceTargets();
    if (version !== generation.current) return;
    refreshing.current = false;
    setQueried(true);
    setListError(error ?? null);
    setTargets(found);
    // 先铺一行"检测中"，再逐台问服务器 —— 不铺会出现"点了没反应"的空档
    setRows(
      Object.fromEntries(found.map((t) => [t.sessionId, { ...EMPTY_ROW }])),
    );
    setLoading(false);
    await Promise.all(
      found.map(async (t) => {
        const probe = await probeCarapaceTarget(t.sessionId);
        patch(t.sessionId, { probe }, version);
      }),
    );
  };

  const install = async (t: CarapaceTarget) => {
    if (refreshing.current || installing.current.has(t.sessionId)) return;
    installing.current.add(t.sessionId);
    const version = generation.current;
    patch(t.sessionId, { installing: true, stage: null, error: null, message: null }, version);
    const { ok, message } = await installCarapaceTarget(t.sessionId, (stage) =>
      patch(t.sessionId, { stage }, version),
    );
    installing.current.delete(t.sessionId);
    if (version !== generation.current) return;
    if (ok) {
      patch(t.sessionId, {
        installing: false,
        stage: null,
        message: message ?? "已装好",
        probe: { state: "installed" },
      }, version);
    } else {
      patch(t.sessionId, {
        installing: false,
        stage: null,
        error: message ?? "安装失败（没有拿到具体原因）",
        probe: null,
      }, version);
      // 失败后服务器状态未知，重问一次而不是留着上一次的读数
      const probe = await probeCarapaceTarget(t.sessionId);
      patch(t.sessionId, { probe }, version);
    }
  };

  return (
    <div
      data-testid="carapace-admin-card"
      className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/40 p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11.5px] text-muted-foreground">
          正连着的服务器
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-fit text-[11.5px]"
          onClick={() => void refresh()}
          disabled={loading || Object.values(rows).some((row) => row.installing)}
        >
          {loading ? "查询中…" : "刷新"}
        </Button>
      </div>

      {listError ? (
        <p data-testid="carapace-list-error" className="text-[11px] text-destructive">
          {listError}
        </p>
      ) : null}

      {!queried && !loading ? (
        <p data-testid="carapace-idle" className="text-[11px] leading-relaxed text-muted-foreground">
          点击刷新，查询已连接的服务器及补全组件状态。
        </p>
      ) : null}

      {queried && !loading && targets.length === 0 && !listError ? (
        <p data-testid="carapace-empty" className="text-[11px] leading-relaxed text-muted-foreground">
          现在没有正连着的服务器。先连上一台（「新建工作区」里选 SSH），再回来点刷新。
        </p>
      ) : null}

      {targets.map((t) => {
        const row = nextRow(rows, t.sessionId);
        const installed = row.probe?.state === "installed";
        return (
          <div
            key={t.sessionId}
            data-testid="carapace-row"
            className="flex items-center justify-between gap-3 border-t border-border/40 pt-2"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[11.5px] font-medium">{t.label}</span>
              <span
                data-testid="carapace-row-status"
                className="text-[10.5px] leading-relaxed text-muted-foreground"
              >
                {statusText(row)}
              </span>
              {row.error ? (
                <span
                  data-testid="carapace-row-error"
                  className="text-[10.5px] leading-relaxed text-destructive break-words"
                >
                  {row.error}
                </span>
              ) : null}
              {row.message && !row.error ? (
                <span
                  data-testid="carapace-row-message"
                  className="text-[10.5px] leading-relaxed text-muted-foreground"
                >
                  {row.message}
                </span>
              ) : null}
            </div>
            <Button
              data-testid="carapace-install"
              variant={installed ? "outline" : "default"}
              size="sm"
              className="h-7 w-fit shrink-0 text-[11.5px]"
              disabled={loading || row.installing || row.probe === null || installed}
              onClick={() => void install(t)}
            >
              {installed ? "已装好" : "装到这台服务器"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function nextRow(
  rows: Record<number, RowState>,
  id: number,
): RowState {
  return rows[id] ?? EMPTY_ROW;
}
