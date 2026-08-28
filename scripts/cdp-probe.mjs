// CDP 探针：连接 WebView2 (9222) 检查页面实际渲染状态（诊断黑屏用）
// 用法: node scripts/cdp-probe.mjs
import http from "node:http";

http.get("http://127.0.0.1:9222/json", (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    const pages = JSON.parse(data).filter((p) => p.type === "page");
    if (!pages.length) {
      console.log("NO_PAGE");
      process.exit(1);
    }
    const page = pages[0];
    console.log("URL:", page.url);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      console.log("CDP_EVAL_TIMEOUT");
      process.exit(1);
    }, 6000);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            returnByValue: true,
            expression: `JSON.stringify({
              readyState: document.readyState,
              rootChildren: document.getElementById("root")?.childElementCount ?? -1,
              rootHtml: (document.getElementById("root")?.innerHTML ?? "").slice(0, 150),
              bodyText: document.body.innerText.replace(/\\s+/g, " ").slice(0, 120),
              title: document.title,
              hasViteErrorOverlay: !!document.querySelector("vite-error-overlay"),
            })`,
          },
        }),
      );
    };
    ws.onmessage = (e) => {
      clearTimeout(timer);
      const msg = JSON.parse(e.data);
      if (msg.id === 1) {
        console.log("STATE:", msg.result?.result?.value ?? JSON.stringify(msg));
        process.exit(0);
      }
    };
    ws.onerror = (err) => {
      console.log("WS_ERROR", String(err?.message ?? err));
      process.exit(1);
    };
  });
}).on("error", (e) => {
  console.log("HTTP_ERROR", e.message);
  process.exit(1);
});
