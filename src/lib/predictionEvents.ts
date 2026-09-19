/**
 * predictionEvents.ts — 设置窗 ↔ 主窗之间的预测历史指令通道
 * -----------------------------------------------------------------------------
 * 预测历史是**主窗内存里**的东西（suggest-engine 单例），而设置窗是独立的 JS
 * context：在设置窗里 import 引擎再 clearHistory()，清的是它自己那份空引擎，
 * 主窗的候选一条都不会少（2026-09-19 真机探针实测出来的）。所以清空必须发回主窗执行。
 *
 * 单独成模块还有一个硬约束：本文件**不得**引入 suggest-engine 或任何终端代码。
 * 设置窗只为发一条指令就要引它，一旦这里把引擎带进来，设置窗首屏就背着整套终端
 * 依赖跑；主窗侧（src/main.tsx 动态 import 注入链）也靠这个常量对齐事件名。
 */
export const PREDICTION_CLEAR_EVENT = "tdsf:prediction-clear";

/** 发起方（设置窗）指向的窗口 label，与 tauri.conf.json 的主窗一致 */
export const MAIN_WINDOW_LABEL = "main";
