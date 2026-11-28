async (page) => {
  const writes = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && ["/api/session", "/api/attempts"].includes(new URL(request.url()).pathname)) writes.push(request.url());
  });
  await page.goto(`http://127.0.0.1:4173/?probe=static-playthrough-${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.locator("#catalog-status").filter({ hasText: "本地目录 · 后端未连接" }).waitFor({ state: "visible", timeout: 10000 });
  const catalog = await page.evaluate(() => ({
    status: document.querySelector("#catalog-status")?.textContent,
    packs: document.querySelector("#pack-count")?.textContent,
    commands: document.querySelector("#command-count")?.textContent
  }));
  await page.locator('#terminal-mount[data-state="awaiting-login"]').waitFor({ state: "visible", timeout: 45000 });
  await page.waitForTimeout(5000);
  const input = page.locator("#terminal-mount .xterm-helper-textarea");
  await input.pressSequentially("root");
  await input.press("Enter");
  await page.locator('#terminal-mount[data-state="ready"]').waitFor({ state: "visible", timeout: 30000 });
  const groups = [
    ["pwd", "ls -la", "cat /etc/os-release"],
    ["id", "ls -l /etc/passwd", "grep '^root:' /etc/passwd"],
    ["df -h", "du -sh /root", "find /root -maxdepth 1 -type f | sort"],
    ["ps", "top -b -n 1", "free -m"],
    ["ifconfig -a", "route -n", "ping -c 1 127.0.0.1"],
    ["uname -a", "dmesg | tail -n 5", "uptime"]
  ];
  for (let taskIndex = 0; taskIndex < groups.length; taskIndex += 1) {
    await page.locator(".task-button").nth(taskIndex).click();
    for (const command of groups[taskIndex]) {
      await page.locator("#hint-button").click();
      await page.waitForFunction((expected) => document.querySelector("#explain-command")?.dataset.command === expected
        && document.querySelector("#receipt-status")?.textContent === "已填入", command, { timeout: 5000 });
      await input.press("Enter");
      await page.locator("#receipt-status").filter({ hasText: "已执行" }).waitFor({ state: "visible", timeout: 5000 });
    }
  }
  await page.locator("#learning-complete").waitFor({ state: "visible", timeout: 5000 });
  const completion = await page.evaluate(() => ({
    progress: document.querySelector("#progress-count")?.textContent,
    recap: document.querySelectorAll("#recap-list .recap-item").length
  }));
  if (writes.length) throw new Error(`static mode must not write progress, received ${writes.length} POST requests`);
  return { catalog, completion, writes: writes.length };
}
