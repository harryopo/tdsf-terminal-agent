# P0 修复方案 — Sidecar 重启循环指数退避 + 用户可取消

> 文件位置：`docs/reports/sidecar-p0-fix-plan.md`
> 编写时间：2026-07-30
> 适用基线：`crynta/terax-ai` v0.8.6 魔改版（当前 HEAD）
> 修复目标文件：`src-tauri/src/modules/sidecar.rs`（仅此一个 Rust 文件）
> 约束：只动 Rust，不动 TS/Python；五绿门禁（typecheck/lint/test/build:web 不受影响，新增 `cargo check` + `cargo test` 验证）

---

## 0. 一句话结论

`sidecar.rs` 的 `start_restart_loop`（`:348-393）收到重启信号后**立即**调用 `manager.start()`，无任何退避；而 `start()` 成功时又在 `:307` **无条件重置 `retry_count=0`**，导致"Python 发 ready 后即崩"场景下 `exit_watcher_task` 的 `MAX_RETRY` 永不触发——形成**无限快速重启循环**。本方案给出指数退避（1/2/4/8/16s，上限 60s）+ 最大重试 5 次 + 运行冷却重置 + 用户可取消的完整 diff。

---

## 1. 问题精确定位（file:line 证据）

### 1.1 重启链全貌

```
lib.rs:235   SidecarManager::new(script)
lib.rs:245   start_restart_loop().await     ← 启动 restart_loop task（在 start() 之前）
lib.rs:249+  sidecar_manager.start()        ← 首次启动 Python

sidecar.rs:256-340   start()
  ├─ :271   spawn_python() → (child, stdin, stdout)
  ├─ :298   存 child 到 self.child
  ├─ :304   wait_for_ready()  ← Python 崩溃时 reader_task 标 Crashed，此处立即返回 Err
  ├─ :307   retry_count.store(0)  ← ⚠️ 无条件重置（无限重启根因）
  └─ :331   spawn(exit_watcher_task)  ← 仅 start() 成功才 spawn

sidecar.rs:348-393   start_restart_loop()
  └─ :373   match manager.start().await { ... }  ← ⚠️ 收到信号立即 start，无 sleep

sidecar.rs:943-1038  exit_watcher_task()
  ├─ :980   retry = retry_count.fetch_add(1)  ← 返回旧值并自增
  ├─ :981   if retry >= MAX_RETRY(3) { Crashed + return }
  └─ :1019  restart_tx.send(())  ← 发信号给 restart_loop
```

### 1.2 真实行为分析（纠正前次审计"毫秒级空转 3 次"的不准确描述）

前次审计（`modded-agent-deep-audit.md` §0）称"Python 启动期失败时毫秒级空转 3 次后 Crashed"。经逐行核实，**该描述不准确**，真实行为按场景分如下：

| 场景 | 触发条件 | 实际行为 | 是否循环 |
|------|----------|----------|----------|
| A. spawn 失败 | python 解释器/脚本不存在 | `start()` 在 `spawn_python` 返回 `Err`（`:271`），`exit_watcher` 未 spawn，**不自动重启** | ❌ 单次失败 |
| B. ready 前崩溃 | Python import 阶段失败等 | `spawn_python` 成功但 Python 立即退出 → `reader_task` 标 Crashed（`:767`）→ `wait_for_ready` 检测到 Crashed 立即返回 `Err`（`:674-678`）→ `start()` 返回 `Err` → `exit_watcher` **未 spawn**（`:331` 未到达）→ **不自动重启**；child 句柄泄漏在 `self.child`（`:298` 存入但无人 `wait`） | ❌ 单次失败 |
| C. ready 后崩溃 | 运行时崩溃 | `start()` 成功 → `:307` **retry_count 重置为 0** → `:331` spawn `exit_watcher` → Python 崩溃 → `:980` retry=0 fetch_add→1，0<3 发信号 → `restart_loop` **立即** `start()` → 若新 Python 又发 ready 后崩溃 → `:307` **又重置为 0** → 永远 0→1→0→1… | ✅ **无限快速重启**（每次循环仅 spawn+ready 握手时间，百毫秒级） |
| C→B 混合 | 第1次 ready 后崩，第2次 ready 前崩 | 第1次触发 exit_watcher 发信号 → restart_loop start() 第2次失败（ready 前崩）→ exit_watcher 未 spawn → 不再重启 | ❌ 重启 1 次后停 |

**核心结论**：
1. **前次"3 次后 Crashed"几乎不会发生**——场景 B/C→B 下 `exit_watcher` 不 spawn，发不出 3 次信号。
2. **真正的 P0 Bug 是场景 C 的"无限快速重启"**：`start():307` 无条件 `retry_count.store(0)` 抵消了 `exit_watcher:980` 的 `fetch_add`，`MAX_RETRY` 永不触发，`restart_loop` 无退避立即 `start()`，Python 反复 spawn→ready→崩溃→再 spawn，CPU 与日志双爆。
3. 次要缺陷：场景 B 下 child 句柄泄漏（`self.child` 被下次 `start()` 覆盖前未 `wait`）。

### 1.3 前次审计方案为何不完整

前次审计（§5 P0 行）建议"`sidecar.rs:1006` 前插入指数退避（1s/2s/4s，上限 10s）"，4 行代码。该方案：
- ❌ 未触及 `:307` 的 `retry_count` 无条件重置——即便加了退避，场景 C 下 `retry_count` 永远是 0/1，退避永远是 `2^0=1s`，**不会递增**，且永不达 `MAX_RETRY`，仍是无限重启（只是每次间隔 1s）。
- ❌ 未提供用户取消机制——退避 sleep 期间用户点"停止 Sidecar"不会中断。
- ❌ 未处理场景 B 的 child 句柄泄漏。

本方案针对以上三点全部修复。

---

## 2. 修复方案设计

### 2.1 设计要点

| 维度 | 设计 |
|------|------|
| 退避策略 | 指数退避 `2^(retry-1)` 秒：1 / 2 / 4 / 8 / 16 / 32 / 60（上限 60s），`retry` 取 `retry_count` 当前值（exit_watcher 已 fetch_add 自增后的值） |
| 最大重试 | `MAX_RETRY` 3 → **5**（配合冷却重置后，5 次足够覆盖偶发崩溃） |
| 计数器重置 | **移除 `start():307` 的无条件重置**；改为"运行冷却"机制：`exit_watcher` 检测到 Python 运行时长 ≥ `RUNTIME_COOLDOWN`(60s) 才崩溃时，先重置 `retry_count=0` 再 `fetch_add`；手动 `restart()` 仍无条件重置 |
| 用户取消 | 新增 `cancel_tx: UnboundedSender<()>`，`stop()` 发送；`restart_loop` 退避 sleep 期间 `select!` 监听，收到即终止循环 |
| 并发安全 | `SidecarManager` 已 `#[derive(Clone)]`，所有字段 `Arc<...>`；新增 `cancel_tx` 同样用 `Arc<Mutex<Option<UnboundedSender>>>`，与现有 `restart_tx` 同模式 |
| child 泄漏修复 | `start()` 失败路径（`wait_for_ready` 返回 Err）补 `child.kill()` + `wait()` 清理 |

### 2.2 状态机变化

修复前：
```
Running →(崩溃)→ Restarting →(立即 start)→ Starting →(ready)→ Running   ← retry_count 被重置，无限循环
                              →(start 失败)→ Crashed
```

修复后：
```
Running →(崩溃, 运行<60s)→ Restarting →(退避 2^retry s)→ Starting →(ready)→ Running(retry_count 不重置)
                                                  →(start 失败)→ Crashed(若 retry>=5) 或继续退避重试
Running →(崩溃, 运行≥60s)→ Restarting → retry_count 重置 → 退避 1s → Starting...
任意状态 →(用户 stop)→ cancel 信号 → 退避 sleep 中断 → 循环退出
```

---

## 3. 具体 Diff（`src-tauri/src/modules/sidecar.rs`）

### 3.1 常量调整（`:60` 附近）

```diff
 /// 最大重启次数（Fix-loop DEC-V321-11）
-const MAX_RETRY: u32 = 3;
+const MAX_RETRY: u32 = 5;
+
+/// 重启退避基准（秒）：backoff = 2^(retry-1)，首重试 1s
+const RESTART_BACKOFF_BASE: u64 = 1;
+
+/// 重启退避上限（秒）
+const RESTART_BACKOFF_MAX: Duration = Duration::from_secs(60);
+
+/// 运行冷却阈值：Python 运行超过此时长后崩溃，视为偶发，重置 retry_count
+const RUNTIME_COOLDOWN: Duration = Duration::from_secs(60);
```

### 3.2 SidecarManager 新增 cancel_tx 字段（`:196` 附近）

```diff
 #[derive(Clone)]
 pub struct SidecarManager {
     state: Arc<RwLock<SidecarState>>,
     stdin_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<String>>>>,
     child: Arc<Mutex<Option<Child>>>,
     pending_requests: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
     next_request_id: Arc<AtomicI64>,
     retry_count: Arc<AtomicU32>,
     app_handle: Arc<Mutex<Option<AppHandle>>>,
     script_path: Arc<Mutex<PathBuf>>,
     restart_tx: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<()>>>>,
+    /// 重启取消信号发送端（stop() 发送 → restart_loop 在退避 sleep 中接收，中断循环）
+    cancel_tx: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<()>>>>,
 }
```

### 3.3 new() 初始化新字段（`:230` 附近）

```diff
             retry_count: Arc::new(AtomicU32::new(0)),
             app_handle: Arc::new(Mutex::new(None)),
             script_path: Arc::new(Mutex::new(script_path)),
             restart_tx: Arc::new(Mutex::new(None)),
+            cancel_tx: Arc::new(Mutex::new(None)),
         }
```

### 3.4 start() 移除无条件重置 + 失败路径清理 child（`:303-340`）

```diff
         // 6. 等待 ready 通知（10s 超时）
-        self.wait_for_ready().await?;
+        if let Err(e) = self.wait_for_ready().await {
+            // TDSF P0 修复：ready 失败时清理已 spawn 的 child，避免句柄泄漏
+            // （场景 B：Python import 阶段崩溃，start() 提前返回，exit_watcher 未 spawn）
+            let mut guard = self.child.lock().await;
+            if let Some(mut child) = guard.take() {
+                let _ = child.kill().await;
+                let _ = child.wait().await;
+            }
+            drop(guard);
+            // 清理 stdin_tx
+            let mut stdin_guard = self.stdin_tx.lock().await;
+            *stdin_guard = None;
+            return Err(e);
+        }
 
-        // 7. 重置 retry_count（启动成功）
-        self.retry_count.store(0, Ordering::SeqCst);
+        // 7. TDSF P0 修复：不再在此处无条件重置 retry_count
+        //    重置逻辑移到 exit_watcher_task 的"运行冷却"判断中（运行 ≥60s 后崩溃才重置）
+        //    手动 restart() 仍保留无条件重置。这样"发 ready 后即崩"场景下 retry_count
+        //    持续递增，配合退避与 MAX_RETRY 终止循环。
 
         // 8. 启动 health check task
```

### 3.5 start_restart_loop() 加退避 + 取消监听（`:348-393`）

```diff
     pub async fn start_restart_loop(&self) {
         let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
         {
             let mut guard = self.restart_tx.lock().await;
             *guard = Some(tx);
         }
+        // 创建 cancel channel，stop() 持有发送端
+        let (cancel_tx, mut cancel_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
+        {
+            let mut guard = self.cancel_tx.lock().await;
+            *guard = Some(cancel_tx);
+        }
 
         let manager = self.clone();
         tokio::spawn(async move {
             log::info!("[sidecar:restart_loop] started");
             while let Some(()) = rx.recv().await {
                 log::info!("[sidecar:restart_loop] received restart signal");
 
-                // 检查状态：Stopping/Stopped 时不重启
+                // 1. 检查状态：Stopping/Stopped 时不重启
                 let need_restart = {
                     let state = manager.state.read().await;
                     !(state.status == SidecarStatus::Stopping
                         || state.status == SidecarStatus::Stopped)
                 };
                 if !need_restart {
                     log::info!("[sidecar:restart_loop] skip restart (stopping/stopped)");
                     continue;
                 }
 
-                // 调用 start() 重启
+                // 2. TDSF P0 修复：指数退避（基于 retry_count，已被 exit_watcher fetch_add 自增）
+                let retry = manager.retry_count.load(Ordering::SeqCst);
+                let backoff_secs = RESTART_BACKOFF_BASE
+                    .saturating_mul(1u64.saturating_shl(retry.saturating_sub(1).min(6)));
+                let backoff = Duration::from_secs(backoff_secs).min(RESTART_BACKOFF_MAX);
+                log::info!(
+                    "[sidecar:restart_loop] backing off {:?} before restart (retry_count={})",
+                    backoff, retry
+                );
+
+                // 3. 退避等待，期间监听取消信号（用户 stop() 可中断）
+                tokio::select! {
+                    _ = tokio::time::sleep(backoff) => {}
+                    _ = cancel_rx.recv() => {
+                        log::info!("[sidecar:restart_loop] cancelled during backoff, exiting loop");
+                        break;
+                    }
+                }
+
+                // 4. 再次检查状态（sleep 期间用户可能已 stop）
+                let need_restart = {
+                    let state = manager.state.read().await;
+                    !(state.status == SidecarStatus::Stopping
+                        || state.status == SidecarStatus::Stopped)
+                };
+                if !need_restart {
+                    log::info!("[sidecar:restart_loop] skip restart after backoff (stopping/stopped)");
+                    continue;
+                }
+
+                // 5. 调用 start() 重启
                 match manager.start().await {
                     Ok(()) => log::info!("[sidecar:restart_loop] restart succeeded"),
                     Err(e) => {
                         log::error!("[sidecar:restart_loop] restart failed: {}", e);
+                        // start() 失败时 retry_count 未达 MAX_RETRY，exit_watcher 仍会发后续信号
+                        // （若新 child spawn 成功且崩溃）；若 spawn 本身失败则无后续信号，循环自然停止
                         {
                             let mut state = manager.state.write().await;
                             state.status = SidecarStatus::Crashed;
                         }
                         let guard = manager.app_handle.lock().await;
                         if let Some(handle) = guard.as_ref() {
                             let _ = handle.emit(
                                 "sidecar:crashed",
                                 json!({"reason": "restart_failed", "error": e.to_string()}),
                             );
                         }
                     }
                 }
             }
             log::info!("[sidecar:restart_loop] stopped");
         });
     }
```

> 说明：`backoff_secs` 公式 `1 << (retry-1)`，retry=1→1s，retry=2→2s，retry=3→4s，retry=4→8s，retry=5→16s，retry≥7→64s 但被 `min(60)` 截断。`saturating_sub/min` 防止溢出（retry=0 时退 1s，因 exit_watcher 已 fetch_add 自增，正常路径 retry≥1）。

### 3.6 stop() 发送 cancel 信号（`:396-451`，在"1. 更新状态为 Stopping"之后）

```diff
     pub async fn stop(&self) -> SidecarResult<()> {
         log::info!("[sidecar] stopping...");
 
         // 1. 更新状态为 Stopping
         {
             let mut state = self.state.write().await;
             state.status = SidecarStatus::Stopping;
         }
 
+        // TDSF P0 修复：通知 restart_loop 中断退避 sleep，停止重试循环
+        {
+            let guard = self.cancel_tx.lock().await;
+            if let Some(tx) = guard.as_ref() {
+                let _ = tx.send(());
+            }
+        }
+
         // 2. 发送 shutdown 方法（best effort，不等待响应）
```

### 3.7 exit_watcher_task 加运行冷却重置（`:979-1004`）

```diff
     // 4. 检查 retry 次数
+    // TDSF P0 修复：运行冷却判断——若 Python 运行 ≥60s 才崩溃，视为偶发，重置 retry_count
+    let runtime = {
+        let state_guard = state.read().await;
+        state_guard.started_at.map(|t| t.elapsed()).unwrap_or(Duration::ZERO)
+    };
+    if runtime >= RUNTIME_COOLDOWN {
+        log::info!(
+            "[sidecar:watcher] runtime {:?} >= cooldown, resetting retry_count",
+            runtime
+        );
+        retry_count.store(0, Ordering::SeqCst);
+    }
+
     let retry = retry_count.fetch_add(1, Ordering::SeqCst);
     if retry >= MAX_RETRY {
         log::error!(
             "[sidecar:watcher] max retry exceeded ({}/{}), giving up",
             retry, MAX_RETRY
         );
```

> 说明：冷却重置放在 `fetch_add` **之前**。这样偶发崩溃（运行 ≥60s）会重置计数器，从 1 开始重新计数，不累积历史偶发；而快速崩溃（运行 <60s，场景 C）不重置，retry_count 持续递增直至 MAX_RETRY。

### 3.8 restart() 保留手动重置（`:454-460`，无需改动，确认）

```rust
pub async fn restart(&self) -> SidecarResult<()> {
    log::info!("[sidecar] manual restart requested");
    self.retry_count.store(0, Ordering::SeqCst);  // ← 保留：用户手动重启重置计数
    self.stop().await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    self.start().await
}
```

---

## 4. 并发安全分析

| 共享状态 | 类型 | 并发场景 | 安全性 |
|----------|------|----------|--------|
| `retry_count` | `Arc<AtomicU32>` | exit_watcher `fetch_add` / `store` + restart_loop `load` | ✅ 原子操作，无数据竞争 |
| `cancel_tx` | `Arc<Mutex<Option<UnboundedSender>>>` | stop() `send` + start_restart_loop `recv`（recv 是局部 `cancel_rx`） | ✅ Mutex 保护 Option，channel 自身线程安全 |
| `state.status` | `Arc<RwLock<SidecarState>>` | restart_loop / exit_watcher / health_check / stop 并发读写 | ✅ RwLock，已有模式不变 |
| `self.child` | `Arc<Mutex<Option<Child>>>` | start() 存入 / exit_watcher take / start() 失败路径 take+kill | ✅ Mutex 串行化；失败路径新增 take+kill 不与 exit_watcher 冲突（exit_watcher 仅在 start() 成功时 spawn，与失败路径互斥） |

**关键无死锁保证**：
- `stop()` 持有 `cancel_tx.lock()` 时不持有 `state.write()`（分段 block，与现有代码风格一致）。
- `start()` 失败路径先 `child.lock().take()` 释放后再 `stdin_tx.lock()`，不嵌套持锁。

---

## 5. 五绿门禁验证

| 门禁 | 影响 | 验证方式 |
|------|------|----------|
| `pnpm typecheck` | ❌ 无（仅动 Rust） | 无需额外验证 |
| `pnpm lint` | ❌ 无 | 无需额外验证 |
| `pnpm test` (830) | ❌ 无（TS 测试） | 无需额外验证 |
| `pnpm build:web` | ❌ 无 | 无需额外验证 |
| `cargo check` | ✅ 有 | `cd src-tauri && cargo check` 必须 0 错误 |
| `cargo test` | ✅ 有 | `cd src-tauri && cargo test`，现有 3 个 sidecar 单测仍过；建议追加退避计算单测（见 §6） |
| `pnpm tauri:dev` | ✅ 有 | 桌面端实测：① 正常启动 ② 故意写坏 sidecar 脚本触发场景 B，验证不再无限重启 + 日志显示退避 ③ 运行中 kill Python 触发场景 C，验证退避递增 + 5 次后 Crashed ④ 退避期间点"停止"验证取消 |

---

## 6. 建议追加的单元测试

```rust
#[test]
fn test_backoff_calculation() {
    // retry=1 → 1s, retry=2 → 2s, retry=3 → 4s, retry=4 → 8s, retry=5 → 16s
    fn backoff(retry: u32) -> Duration {
        let secs = RESTART_BACKOFF_BASE
            .saturating_mul(1u64.saturating_shl(retry.saturating_sub(1).min(6)));
        Duration::from_secs(secs).min(RESTART_BACKOFF_MAX)
    }
    assert_eq!(backoff(1), Duration::from_secs(1));
    assert_eq!(backoff(2), Duration::from_secs(2));
    assert_eq!(backoff(3), Duration::from_secs(4));
    assert_eq!(backoff(4), Duration::from_secs(8));
    assert_eq!(backoff(5), Duration::from_secs(16));
    assert_eq!(backoff(7), Duration::from_secs(60)); // 上限截断
    assert_eq!(backoff(0), Duration::from_secs(1));  // 防御性：retry=0 退 1s
}

#[test]
fn test_max_retry_is_five() {
    assert_eq!(MAX_RETRY, 5);
}
```

---

## 7. 风险与回滚

| 风险 | 概率 | 缓解 |
|------|------|------|
| 退避公式 `1 << (retry-1)` 在 retry=0 时 panic（shift underflow） | 低 | `saturating_sub` 已防护，retry=0 时 `1<<0=1`；单测覆盖 |
| 冷却重置导致偶发崩溃后 retry_count 不累积，仍无限重启 | 低 | 仅当"运行≥60s 后崩溃"且反复发生才会重置；偶发崩溃本就不应累积计数，属设计预期 |
| cancel_tx 在 restart_loop 退出后 send 失败 | 无害 | `let _ = tx.send(())` 忽略错误，channel closed 无副作用 |
| start() 失败路径新增 child.kill() 在某些平台行为差异 | 低 | `kill()` + `wait()` 是 tokio 标准模式，已有 `stop()` 用同样写法（`:417-421`） |

**回滚**：本方案仅改 `sidecar.rs` 一个文件，`git revert` 单次提交即可回滚。

---

## 8. 实施清单

- [ ] 应用 §3.1–3.7 的 diff 到 `src-tauri/src/modules/sidecar.rs`
- [ ] 追加 §6 单元测试
- [ ] `cd src-tauri && cargo check`（0 错误）
- [ ] `cd src-tauri && cargo test`（全过）
- [ ] `pnpm tauri:dev` 实测四场景（§5 最后一行）
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build:web`（确认 TS 侧无回归）
- [ ] git commit（固化回滚点）
- [ ] 更新 `docs/dev-state.md` P2-5 条目：标记 P0 退避已修

---

> 方案编写：TRAE 子 Agent（GLM-5.2）
> 审计原则：治本不治标、并发安全、五绿全过、可回滚
> 前置基线：`docs/reports/modded-agent-deep-audit.md`（深化版审计报告）
