// 设置窗那个标题：HTML 与 Rust 两处必须一字不差。
//
// 为什么要有这条（#166 看图轮续，2026-09-29）：真机开设置窗看图时读到
// `document.title === "TDSF — Settings"`，而 Rust 建窗时写的是 `.title("Settings")` ——
// **同一个可见事实（任务栏 / Alt-Tab 上那一行字）有两个主人，还互相不一样**。
// 页面加载后是 document.title 说了算，Rust 那份只在加载前那一瞬生效，
// 于是"改一处就够"是错觉：另一处会悄悄漂走。
//
// 顺带这一格是全站唯一还写着 `lang="en"` 的界面（正文全是中文）—— 读屏与字体 shaping 都会照
// 错误语言走，一并钉住。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(join(process.cwd(), "settings.html"), "utf8");
const rust = readFileSync(join(process.cwd(), "src-tauri/src/lib.rs"), "utf8");

function htmlTitle(): string {
  const m = html.match(/<title>([^<]*)<\/title>/);
  // 正向配对：解析不到就报错，不许"因为取不到而通过"
  if (!m) throw new Error("settings.html 里没有 <title> —— 判据自身失效");
  return m[1].trim();
}

function rustTitle(): string {
  // 按锚点取，不按"文件里第一个 .title(...)"取：lib.rs 里还有别的建窗调用，
  // 位置会随代码移动而变，而这条要钉的正是**设置窗**那一个。
  const anchor = rust.indexOf("WebviewUrl::App(url_path.into())");
  if (anchor < 0) {
    throw new Error("lib.rs 里找不到设置窗的建窗锚点 —— 判据自身失效");
  }
  const m = rust.slice(anchor).match(/\.title\("([^"]*)"\)/);
  if (!m) throw new Error("设置窗建窗链上没有 .title(...) —— 判据自身失效");
  return m[1];
}

describe("设置窗标题只有一个事实", () => {
  it("HTML 与 Rust 两份一字不差", () => {
    expect(rustTitle()).toBe(htmlTitle());
  });

  it("标题是中文界面词，不夹英文（全站界面一律中文）", () => {
    const t = htmlTitle();
    expect(/[\u4e00-\u9fff]/.test(t)).toBe(true);
    expect(t).not.toMatch(/Settings/i);
  });

  it("settings.html 声明的语言与实际内容一致", () => {
    expect(html).toMatch(/<html lang="zh-CN"/);
  });
});
