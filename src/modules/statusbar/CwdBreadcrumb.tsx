import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { FileTreeSource } from "@/modules/explorer/lib/useFileTree";
import type { FsEntry } from "@/modules/explorer/lib/workspaceFsStore";
import {
  ipcWorkspaceEnv,
  useWorkspaceEnvStore,
  workspaceScopeKey,
} from "@/modules/workspace";
import {
  ArrowDown01Icon,
  Folder01Icon,
  Home03Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { segmentsFromCwd } from "./lib/pathUtils";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
  source?: FileTreeSource | null;
  canNavigate?: boolean;
};

function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return "/";
  return path.slice(0, i);
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i === -1 ? path : path.slice(i + 1);
}

export function CwdBreadcrumb({
  cwd,
  filePath,
  home,
  onCd,
  source,
  canNavigate = true,
}: Props) {
  const disabled = !canNavigate || source === null;
  // File mode: dir segments navigate; filename is the terminal leaf.
  if (filePath) {
    const dir = dirname(filePath);
    const name = basename(filePath);
    const segments = segmentsFromCwd(dir, home);
    const first = segments[0];
    const middle = segments.slice(1);
    return (
      <Breadcrumb>
        <BreadcrumbList className="gap-1 py-0.5 text-xs sm:gap-1.5">
          {first ? (
            <BreadcrumbSegment
              label={first.label}
              isHome={first.isHome}
              disabled={disabled}
              onClick={() => onCd(first.fullPath)}
            />
          ) : null}
          {middle.length > 0 ? (
            <CollapsedSegments
              segments={middle}
              onCd={onCd}
              disabled={disabled}
            />
          ) : null}
          {middle.map((s) => (
            <span key={s.fullPath} className="contents max-md:hidden">
              <BreadcrumbSegment
                label={s.label}
                isHome={s.isHome}
                disabled={disabled}
                onClick={() => onCd(s.fullPath)}
              />
            </span>
          ))}
          <BreadcrumbItem>
            <BreadcrumbPage className="text-foreground">{name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (!cwd) {
    return (
      <span className="text-xs text-muted-foreground/70">no directory</span>
    );
  }

  const segments = segmentsFromCwd(cwd, home);
  const current = segments[segments.length - 1];
  const parents = segments.slice(0, -1);

  const firstParent = parents[0];
  const middleParents = parents.slice(1);
  return (
    <Breadcrumb>
      <BreadcrumbList className="gap-1 py-0.5 text-xs sm:gap-1.5">
        {firstParent ? (
          <BreadcrumbSegment
            label={firstParent.label}
            isHome={firstParent.isHome}
            disabled={disabled}
            onClick={() => onCd(firstParent.fullPath)}
          />
        ) : null}
        {middleParents.length > 0 ? (
          <CollapsedSegments
            segments={middleParents}
            onCd={onCd}
            disabled={disabled}
          />
        ) : null}
        {middleParents.map((s) => (
          <span key={s.fullPath} className="contents max-md:hidden">
            <BreadcrumbSegment
              label={s.label}
              isHome={s.isHome}
              disabled={disabled}
              onClick={() => onCd(s.fullPath)}
            />
          </span>
        ))}
        <BreadcrumbItem>
          <CurrentSegmentDropdown
            label={current.label}
            path={current.fullPath}
            onCd={onCd}
            source={source}
            disabled={!canNavigate}
          />
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function BreadcrumbSegment({
  label,
  isHome,
  onClick,
  disabled,
}: {
  label: string;
  isHome: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink asChild>
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={disabled ? "请切回已连接的终端切换目录" : undefined}
            aria-label={isHome ? "家目录" : label === "/" ? "根目录 /" : label}
            className="relative flex min-h-6 min-w-6 cursor-pointer items-center justify-center rounded-sm after:absolute after:-inset-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Badge
              variant="outline"
              className="gap-1 text-muted-foreground hover:text-foreground"
            >
              {isHome ? (
                <HugeiconsIcon
                  icon={Home03Icon}
                  className="size-3"
                  strokeWidth={1.75}
                />
              ) : null}
              {isHome ? "Home" : label}
            </Badge>
          </button>
        </BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="[&>svg]:size-3" />
    </>
  );
}

function CurrentSegmentDropdown({
  label,
  path,
  onCd,
  source,
  disabled,
}: {
  label: string;
  path: string;
  onCd: (p: string) => void;
  source?: FileTreeSource | null;
  disabled?: boolean;
}) {
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const [open, setOpen] = useState(false);
  const workspaceKey = useWorkspaceEnvStore((s) => workspaceScopeKey(s.env));
  const sessionId = source?.kind === "sftp" ? source.sessionId : null;
  const root = source?.kind === "sftp" ? source.root : null;
  const offline = source === null;
  const requestKey = JSON.stringify([
    offline,
    sessionId,
    root,
    path,
    showHidden,
    workspaceKey,
  ]);
  const [result, setResult] = useState<{
    key: string;
    children: string[];
    error: string | null;
  } | null>(null);
  const current = result?.key === requestKey ? result : null;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setResult(null);
    if (offline) {
      setResult({
        key: requestKey,
        children: [],
        error: "SSH 未连接，请先重新连接当前终端",
      });
      return;
    }
    const workspace = ipcWorkspaceEnv();
    const listing =
      sessionId !== null
        ? invoke<FsEntry[]>("fsb_list", { sessionId, root, path }).then(
            (entries) =>
              entries
                .filter(
                  (entry) =>
                    entry.is_dir && (showHidden || !entry.name.startsWith(".")),
                )
                .map((entry) => entry.name),
          )
        : invoke<string[]>("list_subdirs", { path, showHidden, workspace });
    void listing.then(
      (children) => {
        if (!cancelled) setResult({ key: requestKey, children, error: null });
      },
      (error) => {
        if (!cancelled)
          setResult({ key: requestKey, children: [], error: String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, offline, sessionId, root, path, showHidden, requestKey]);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setResult(null);
        setOpen(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-current="page"
          aria-label={`浏览子目录：${path}`}
          className="relative flex min-h-6 min-w-6 cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-foreground hover:bg-accent after:absolute after:-inset-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {label === "~" ? (
            <>
              <HugeiconsIcon
                icon={Home03Icon}
                className="size-3"
                strokeWidth={1.75}
              />
              Home
            </>
          ) : (
            label
          )}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className="size-3 opacity-70"
            strokeWidth={2}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {current === null ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            正在读取目录…
          </div>
        ) : current.children.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {current.error ?? "没有子目录"}
          </div>
        ) : (
          current.children.map((name) => (
            <DropdownMenuItem
              key={name}
              onSelect={() =>
                onCd(path.endsWith("/") ? `${path}${name}` : `${path}/${name}`)
              }
            >
              <HugeiconsIcon
                icon={Folder01Icon}
                className="size-3.5 text-muted-foreground"
                strokeWidth={1.75}
              />
              {name}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CollapsedSegments({
  segments,
  onCd,
  disabled,
}: {
  segments: { fullPath: string; label: string; isHome: boolean }[];
  onCd: (p: string) => void;
  disabled?: boolean;
}) {
  return (
    <span className="contents md:hidden">
      <BreadcrumbItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              title="显示隐藏目录"
              aria-label="显示隐藏目录"
              className="relative flex min-h-6 min-w-6 items-center justify-center rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-foreground after:absolute after:-inset-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <HugeiconsIcon
                icon={MoreHorizontalIcon}
                className="size-3"
                strokeWidth={1.75}
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            {segments.map((s) => (
              <DropdownMenuItem
                key={s.fullPath}
                onSelect={() => onCd(s.fullPath)}
              >
                <HugeiconsIcon
                  icon={s.isHome ? Home03Icon : Folder01Icon}
                  className="size-3.5 text-muted-foreground"
                  strokeWidth={1.75}
                />
                <span className="truncate">{s.isHome ? "Home" : s.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="[&>svg]:size-3" />
    </span>
  );
}
