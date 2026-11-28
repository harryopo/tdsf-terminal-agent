async (page) => {
  const attemptPosts = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/attempts") attemptPosts.push(request.url());
  });
  await page.route("**/api/session", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await page.goto(`http://127.0.0.1:8080/?probe=session-fallback-${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.locator("#catalog-status").filter({ hasText: "进度仅本机" }).waitFor({ state: "visible", timeout: 10000 });
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
  if (attemptPosts.length) throw new Error(`session fallback must not sync attempts, received ${attemptPosts.length} POST requests`);
  return { status, attemptPosts: attemptPosts.length };
}
