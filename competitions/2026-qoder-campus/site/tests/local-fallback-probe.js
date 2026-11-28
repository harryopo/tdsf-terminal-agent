async (page) => {
  const sessionPosts = [];
  const attemptPosts = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST") return;
    if (path === "/api/session") sessionPosts.push(request.url());
    if (path === "/api/attempts") attemptPosts.push(request.url());
  });
  await page.goto(`http://127.0.0.1:4173/?probe=local-fallback-${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.locator("#catalog-status").filter({ hasText: "本地目录 · 后端未连接" }).waitFor({ state: "visible", timeout: 10000 });
  await page.locator('#terminal-mount[data-state="awaiting-login"]').waitFor({ state: "visible", timeout: 45000 });
  await page.waitForTimeout(5000);
  const input = page.locator("#terminal-mount .xterm-helper-textarea");
  await input.pressSequentially("root");
  await input.press("Enter");
  await page.locator('#terminal-mount[data-state="ready"]').waitFor({ state: "visible", timeout: 30000 });
  await page.locator(".task-button").nth(0).click();
  await page.locator("#hint-button").click();
  await page.waitForFunction(() => document.querySelector("#explain-command")?.dataset.command === "pwd"
    && document.querySelector("#receipt-status")?.textContent === "已填入");
  await input.press("Enter");
  await page.locator("#receipt-status").filter({ hasText: "已执行" }).waitFor({ state: "visible", timeout: 5000 });
  const status = await page.locator("#catalog-status").textContent();
  if (sessionPosts.length) throw new Error(`local fallback must not create a session, received ${sessionPosts.length} POST requests`);
  if (attemptPosts.length) throw new Error(`local fallback must not sync attempts, received ${attemptPosts.length} POST requests`);
  return { status, sessionPosts: sessionPosts.length, attemptPosts: attemptPosts.length };
}
