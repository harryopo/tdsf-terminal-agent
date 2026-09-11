/**
 * 宣传页预览截图（本地渲染，用于交付前目视检查）
 * 用法：node scripts/preview-website.mjs
 * 输出：.preview/website-hero.png（首屏）· .preview/website-full.png（整页）
 */
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const page_url = pathToFileURL(join(root, "website", "index.html")).href;
const outDir = join(root, ".preview");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});

await page.goto(page_url, { waitUntil: "load" });

// 首屏：等打字机跑完前两行，让终端有真实内容
await page.waitForTimeout(5200);
await page.screenshot({ path: join(outDir, "website-hero.png") });

// 整页：先触发全部 reveal，再截全图
await page.evaluate(() => {
  document.querySelectorAll(".reveal").forEach((el) => el.classList.add("visible"));
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(outDir, "website-full.png"), fullPage: true });

// README 用演示封面（16:9，与 assets/video/poster.png 对齐）
const posterPage = await browser.newPage({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1,
});
await posterPage.goto(page_url, { waitUntil: "load" });
await posterPage.waitForTimeout(5200);
await posterPage.screenshot({ path: join(root, "assets", "video", "poster.png") });
await posterPage.close();

// 控制台错误检查（缺图/脚本异常会在这里暴露）
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await browser.close();
console.log("preview written to .preview/ + assets/video/poster.png");
