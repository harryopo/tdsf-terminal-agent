/**
 * 线上校验演示视频：加载已部署的宣传页，确认 <video> 真的可播放，并抓取一帧作封面。
 * 用法：node scripts/verify-demo-video.mjs
 * 输出：.preview/live-video-frame.png（候选封面，可替换 website/assets/video/poster.png）
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PAGE = "https://harryopo.github.io/tdsf-terminal-agent/";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", ".preview");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-gpu", // 无头下强制软件解码，保证抓帧有画面
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
console.log(`loading ${PAGE}`);
await page.goto(PAGE, { waitUntil: "load", timeout: 60000 });

// 等页面脚本把占位换成播放器（或超时）
const state = await page
  .waitForFunction(
    () => {
      const v = document.getElementById("demo-video");
      const ph = document.getElementById("video-placeholder");
      if (!v) return null;
      if (v.readyState >= 2 && !v.hidden) {
        return {
          ok: true,
          duration: Math.round(v.duration * 10) / 10,
          width: v.videoWidth,
          height: v.videoHeight,
          placeholderHidden: ph?.hidden ?? null,
        };
      }
      if (v.error) {
        return { ok: false, code: v.error.code, message: v.error.message };
      }
      return null;
    },
    { timeout: 45000, polling: 500 },
  )
  .then((h) => h.jsonValue())
  .catch(() => ({ ok: false, message: "timeout waiting for playback" }));

console.log("video state:", JSON.stringify(state));

if (state.ok) {
  // 采样多个时间点，挑一帧最有代表性的画面作封面
  const points = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95];
  const { writeFileSync } = await import("node:fs");
  for (let i = 0; i < points.length; i += 1) {
    const dataUrl = await page.evaluate(async (p) => {
      const v = document.getElementById("demo-video");
      v.muted = true;
      v.currentTime = Math.max(0.5, v.duration * p);
      await new Promise((resolve) => {
        v.addEventListener("seeked", resolve, { once: true });
        setTimeout(resolve, 5000);
      });
      await v.play().catch(() => {});
      await new Promise((resolve) => {
        if (typeof v.requestVideoFrameCallback === "function") {
          v.requestVideoFrameCallback(() => resolve());
          setTimeout(resolve, 2500);
        } else {
          setTimeout(resolve, 1200);
        }
      });
      v.pause();
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL("image/png");
    }, points[i]);
    if (dataUrl?.startsWith("data:image/png;base64,")) {
      writeFileSync(
        join(outDir, `frame-${String(i + 1).padStart(2, "0")}.png`),
        Buffer.from(dataUrl.split(",")[1], "base64"),
      );
      console.log(`frame ${i + 1}/${points.length} @ ${points[i] * 100}%`);
    }
  }
  console.log("frames saved to .preview/frame-*.png");
}

await browser.close();
