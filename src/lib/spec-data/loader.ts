/**
 * loader.ts — 命令 spec 懒加载 (TDSF 2026-08-15)
 * -----------------------------------------------------------------------------
 * 数据源：withfig/autocomplete（MIT，开源最大 CLI spec 数据集，715+ 命令）。
 *
 * 体积策略：
 *   - SPEC_INDEX（命令名/描述索引，~90KB）静态打包进主 bundle，命令层匹配零延迟
 *   - specs.json（全量 spec，~11MB）经 import.meta.glob 打成独立 chunk，首次
 *     需要参数预测时才加载并缓存（Tauri 本地读取 + JSON.parse 约百毫秒级）
 *
 * 生成：node scripts/build-fig-specs.mjs
 */
import type { FigSpec } from "./types";
import { SPEC_INDEX, type SpecIndexEntry } from "./generated/spec-index";

// vite 会把大 JSON 拆成独立 chunk 并按需加载
const specsImporters = import.meta.glob("../generated/specs.json", {
  import: "default",
});

let cache: Record<string, FigSpec> | null = null;
let loading: Promise<Record<string, FigSpec>> | null = null;

/** 加载全量 spec（幂等，首次之后走缓存） */
export function loadSpecs(): Promise<Record<string, FigSpec>> {
  if (cache) return Promise.resolve(cache);
  if (!loading) {
    loading = (async () => {
      const keys = Object.keys(specsImporters);
      const mod = keys.length ? await specsImporters[keys[0]]() : {};
      cache = mod as Record<string, FigSpec>;
      return cache;
    })();
  }
  return loading;
}

/** 取单个命令的 spec（无缓存时触发全量加载） */
export async function getCommandSpec(
  name: string,
): Promise<FigSpec | undefined> {
  const specs = await loadSpecs();
  return specs[name];
}

export { SPEC_INDEX };
export type { SpecIndexEntry };
