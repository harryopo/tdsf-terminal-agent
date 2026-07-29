/**
 * 终端翻译模块入口
 * -----------------------------------------------------------------------------
 * TDSF 魔改 2026-07-29: 离线词典选词翻译（Linux 命令 + 编程术语）
 */
export { useTranslateStore } from "./translateStore";
export { useTranslateSelection } from "./useTranslateSelection";
export { TranslateTooltip } from "./TranslateTooltip";
export {
  translateText,
  translateBatch,
  TOTAL_DICT_SIZE,
  type TranslationResult,
} from "./translateApi";
