import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { invokeRpc } from "@/lib/sidecar-bridge";
import { diagnosticText } from "@/modules/ai/lib/sessionDiagnostics";

type RecoveryDocument = { url: string; title: string; chunks: number; status: "new" | "duplicate" | "conflict" | "builtin"; has_chinese: boolean; source_note: string };
type RecoveryPreview = { token: string; documents: RecoveryDocument[]; counts: Record<RecoveryDocument["status"], number> };
type RecoveryResult = { imported: number; duplicate: number; conflicts: number; entries: number; backup_path: string; source_backup_path: string };
const statusLabels = { new: "可恢复", duplicate: "个人库已有", conflict: "冲突，不覆盖", builtin: "内置已包含" };

function discard(token: string) {
  if (token) void invokeRpc("knowledge.recovery_discard", { token }).catch(() => { /* Server-side previews expire. */ });
}

export function KnowledgeRecoveryDialog({ onClose, onRecovered }: { onClose: () => void; onRecovered: () => void }) {
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<RecoveryPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<"idle" | "previewing" | "applying" | "complete">("idle");
  const [result, setResult] = useState<RecoveryResult | null>(null);
  const [error, setError] = useState("");
  const [errorDetails, setErrorDetails] = useState("");
  const mounted = useRef(false);
  const pending = useRef(false);
  const token = useRef("");
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; discard(token.current); token.current = ""; };
  }, []);

  async function loadPreview() {
    if (pending.current || !path.trim()) return;
    pending.current = true;
    const owner = ++generation.current;
    discard(token.current);
    token.current = "";
    setPreview(null);
    setPhase("previewing");
    setError("");
    setErrorDetails("");
    try {
      const value = await invokeRpc<RecoveryPreview>("knowledge.recovery_preview", { source_path: path.trim() });
      if (!mounted.current || owner !== generation.current) { discard(value.token); return; }
      token.current = value.token;
      setPreview(value);
      setSelected(new Set(value.documents.filter((doc) => doc.status === "new").map((doc) => doc.url)));
    } catch (failure) {
      if (mounted.current && owner === generation.current) {
        setError("预览失败，请检查本地文件路径后重试。");
        setErrorDetails(diagnosticText(failure instanceof Error ? failure.message : failure).slice(0, 1500));
      }
    } finally {
      if (mounted.current && owner === generation.current) { pending.current = false; setPhase("idle"); }
    }
  }

  async function apply() {
    if (pending.current || !preview || !token.current || selected.size === 0) return;
    pending.current = true;
    setPhase("applying");
    setError("");
    setErrorDetails("");
    const currentToken = token.current;
    token.current = "";
    try {
      const value = await invokeRpc<RecoveryResult>("knowledge.recovery_apply", { token: currentToken, urls: [...selected] });
      if (!mounted.current) return;
      setResult(value);
      setPhase("complete");
      if (value.imported > 0) onRecovered();
    } catch (failure) {
      if (mounted.current) {
        setError("恢复失败，未自动重试。请重新预览。");
        setErrorDetails(diagnosticText(failure instanceof Error ? failure.message : failure).slice(0, 1500));
        setPreview(null); setPhase("idle");
      }
    } finally {
      pending.current = false;
    }
  }

  function changePath(value: string) {
    discard(token.current);
    token.current = "";
    setPreview(null);
    setSelected(new Set());
    setPath(value);
    setError("");
    setErrorDetails("");
  }

  return <Dialog open onOpenChange={(open) => { if (!open && phase !== "applying") onClose(); }}>
    <DialogContent showCloseButton={false} aria-describedby="knowledge-recovery-description" className="flex max-h-[85vh] flex-col gap-4 rounded-2xl sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle className="text-lg">恢复已有中文整理</DialogTitle>
        <p id="knowledge-recovery-description" className="mt-1 text-xs leading-6 text-muted-foreground">从本机旧 SQLite 知识库选择文档，先预览再恢复到“我的知识”。不会翻译、删除原库或覆盖冲突；写入前自动备份。</p>
      </DialogHeader>
      {phase !== "complete" && <>
        <label className="space-y-2 text-xs font-medium">旧知识库文件路径
          <Input className="mt-2 font-mono text-xs" value={path} onChange={(event) => changePath(event.target.value)} placeholder="例如 C:\备份\rag_slim.db" disabled={phase === "previewing" || phase === "applying"} />
        </label>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs leading-5 text-muted-foreground">含有中文不代表已验证来源或版权，请只选你确认要恢复的内容。</p>
          <Button variant="outline" size="sm" disabled={!path.trim() || phase !== "idle"} onClick={() => void loadPreview()}>{phase === "previewing" && <Spinner className="mr-1 size-3" />}预览内容</Button>
        </div>
      </>}
      {preview && phase !== "complete" && <>
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-y border-border py-2 text-xs text-muted-foreground">
          <span>{preview.counts.new} 篇可恢复</span><span>{preview.counts.duplicate + preview.counts.builtin} 篇已包含</span><span>{preview.counts.conflict} 篇冲突</span>
        </div>
        <div className="min-h-0 max-h-[38vh] overflow-auto rounded-lg border border-border">
          {preview.documents.length === 0 && <p className="p-4 text-xs text-muted-foreground">未找到可恢复的文档；会话记忆和无文档归属的私人案例不在此处导入。</p>}
          {preview.documents.map((doc) => <label key={doc.url} className="flex items-start gap-3 border-b border-border/50 px-3 py-3 last:border-0">
            <input type="checkbox" className="mt-1 accent-foreground" checked={selected.has(doc.url)} disabled={doc.status !== "new" || phase === "applying"} onChange={(event) => setSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(doc.url); else next.delete(doc.url); return next; })} />
            <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium">{doc.title}</span><span className="mt-1 block break-all text-[11px] text-muted-foreground">{doc.source_note} · {doc.has_chinese ? "含既有中文" : "原文"}</span></span>
            <span className="shrink-0 rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground">{statusLabels[doc.status]}</span>
          </label>)}
        </div>
      </>}
      {result && <div className="min-h-0 space-y-3 overflow-auto rounded-xl border border-border bg-muted/20 p-4 text-sm">
        <p className="font-medium">已恢复 {result.imported} 篇文档</p>
        <p className="text-xs text-muted-foreground">跳过 {result.duplicate} 篇重复、{result.conflicts} 篇冲突；原有内容保持不变。</p>
        {result.backup_path && <p className="break-all text-xs leading-6 text-muted-foreground">恢复前个人库备份：<br />{result.backup_path}</p>}
        {result.source_backup_path && <p className="break-all text-xs leading-6 text-muted-foreground">本次源文件快照：<br />{result.source_backup_path}</p>}
      </div>}
      {error && <div role="alert" className="space-y-2 text-xs leading-6 text-destructive"><p>{error}</p>{errorDetails && <details className="text-muted-foreground"><summary className="cursor-pointer">技术详情（已脱敏）</summary><pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all">{errorDetails}</pre></details>}</div>}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <Button variant="ghost" onClick={onClose} disabled={phase === "applying"}>{phase === "complete" ? "完成" : "取消"}</Button>
        {phase !== "complete" && <Button onClick={() => void apply()} disabled={!preview || selected.size === 0 || phase !== "idle"}>{phase === "applying" ? <><Spinner className="mr-1 size-3" />恢复中…</> : `恢复选中的 ${selected.size} 篇`}</Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
