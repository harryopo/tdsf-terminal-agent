async (page) => {
  const base = "http://127.0.0.1:8080/";
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}?probe=full-playthrough-${Date.now()}`, { waitUntil: "domcontentloaded" });
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
  const completed = [];
  for (let taskIndex = 0; taskIndex < groups.length; taskIndex += 1) {
    await page.locator(".task-button").nth(taskIndex).click();
    for (const command of groups[taskIndex]) {
      await page.locator("#hint-button").click();
      await page.waitForFunction((expected) => document.querySelector("#explain-command")?.dataset.command === expected
        && document.querySelector("#receipt-status")?.textContent === "已填入", command, { timeout: 5000 });
      await input.press("Enter");
      await page.waitForFunction((expected) => document.querySelector("#explain-command")?.dataset.command === expected, command, { timeout: 5000 });
      await page.locator("#receipt-status").filter({ hasText: "已执行" }).waitFor({ state: "visible", timeout: 5000 });
      completed.push(command);
    }
  }
  await page.locator("#learning-complete").waitFor({ state: "visible", timeout: 5000 });
  const completion = await page.evaluate(() => ({
    progress: document.querySelector("#progress-count")?.textContent,
    recap: document.querySelectorAll("#recap-list .recap-item").length
  }));

  await page.route("**/api/progress/reset", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  await page.locator("#restart-learning").click();
  await page.locator('#terminal-mount[data-state="resetting"]').waitFor({ state: "visible" });
  const inputBlocked = await page.locator("#hint-button").isDisabled();
  await input.pressSequentially("pwd");
  await input.press("Enter");
  await page.locator('#terminal-mount[data-state="ready"]').waitFor({ state: "visible", timeout: 6000 });
  const progressAfterReset = await page.evaluate(async () => (await (await fetch("/api/progress")).json()).completed);
  await page.locator("#hint-button").click();
  await input.press("Enter");
  await page.waitForFunction(async () => {
    const body = await (await fetch("/api/progress")).json();
    return body.completed.some((item) => item.stepId === "files-pwd");
  }, null, { timeout: 5000 });
  await page.waitForTimeout(1500);
  const progressAfterNewAttempt = await page.evaluate(async () => (await (await fetch("/api/progress")).json()).completed);

  const failureContext = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
  const failurePage = await failureContext.newPage();
  await failurePage.route("**/api/session", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await failurePage.goto(`${base}?probe=session-failure-${Date.now()}`, { waitUntil: "domcontentloaded" });
  await failurePage.locator("#catalog-status").filter({ hasText: "进度仅本机" }).waitFor({ state: "visible", timeout: 10000 });
  const sessionFailureStatus = await failurePage.locator("#catalog-status").textContent();
  await failureContext.close();

  return {
    completed,
    completion,
    resetRace: {
      inputBlocked,
      progressAfterReset,
      progressAfterNewAttempt,
      newProgressSurvivedOldReset: progressAfterNewAttempt.some((item) => item.stepId === "files-pwd")
    },
    sessionFailureStatus,
    errors
  };
}
