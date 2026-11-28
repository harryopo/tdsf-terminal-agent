async (page) => {
  const base = "http://127.0.0.1:4173/";
  const evidence = globalThis.process?.env?.SHELLLAB_EVIDENCE_DIR || "competitions/2026-qoder-campus/05-作品材料/04-功能截图/harryopo/2026-11-28";
  const browser = page.context().browser();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}?probe=learning-${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.locator('#terminal-mount[data-state="awaiting-login"]').waitFor({ state: "visible", timeout: 45000 });
  await page.getByText("Welcome to Buildroot", { exact: false }).first().waitFor({ state: "visible", timeout: 15000 });
  const input = page.locator("#terminal-mount .xterm-helper-textarea");
  async function waitForReceiptCommand(command) {
    await page.waitForFunction(
      (expected) => document.querySelector("#explain-command")?.dataset.command === expected,
      command,
      { timeout: 5000 }
    );
  }
  await input.pressSequentially("root");
  await input.press("Enter");
  await page.locator('#terminal-mount[data-state="ready"]').waitFor({ state: "visible", timeout: 30000 });
  await page.waitForTimeout(100);

  const runtime = await page.evaluate(() => ({
    guideLabel: document.querySelector("#runtime-guide-label")?.textContent,
    announcer: document.querySelector("#announcer")?.textContent,
    phase: document.querySelector("#terminal-mount")?.dataset.state
  }));
  await page.screenshot({ path: `${evidence}/2026-11-28_harryopo_QODER-CAMPUS-20261126_01_desktop.png`, fullPage: true });

  const taskButtons = page.locator(".task-button");
  await taskButtons.nth(0).click();
  const focusAfterTaskClick = await page.evaluate(() => document.activeElement?.dataset.taskIndex ?? null);
  await page.locator("#hint-button").click();
  await page.waitForTimeout(100);
  const hint = await page.evaluate(() => ({
    receipt: document.querySelector("#receipt-status")?.textContent,
    progress: document.querySelector("#progress-count")?.textContent,
    announcer: document.querySelector("#announcer")?.textContent
  }));
  await input.press("Enter");
  await taskButtons.nth(0).focus();
  await waitForReceiptCommand("pwd");
  await page.locator("#receipt-status").filter({ hasText: "已执行" }).waitFor({ state: "visible", timeout: 5000 });
  await page.waitForTimeout(100);
  const focusAfterCommand = await page.evaluate(() => document.activeElement?.dataset.taskIndex ?? null);

  await input.pressSequentially("whoami");
  await input.press("Enter");
  await waitForReceiptCommand("whoami");
  await page.locator("#receipt-status").filter({ hasText: "未通过" }).waitFor({ state: "visible", timeout: 5000 });
  await page.waitForTimeout(100);
  const wrongCommand = await page.evaluate(() => ({
    title: document.querySelector("#terminal-title")?.textContent,
    progress: document.querySelector("#progress-count")?.textContent,
    announcer: document.querySelector("#announcer")?.textContent
  }));

  const commands = [
    "ls -la",
    "cat /etc/os-release",
    "id",
    "ls -l /etc/passwd",
    "grep '^root:' /etc/passwd",
    "uname -a",
    "dmesg | tail -n 5",
    "uptime"
  ];
  const commandResults = [];
  for (const command of commands) {
    if (command === "id") await taskButtons.nth(1).click();
    if (command === "uname -a") await taskButtons.nth(2).click();
    await input.pressSequentially(command);
    await input.press("Enter");
    await waitForReceiptCommand(command);
    await page.locator("#receipt-status").filter({ hasText: "已执行" }).waitFor({ state: "visible", timeout: 5000 });
    commandResults.push(await page.evaluate((executed) => ({
      command: executed,
      title: document.querySelector("#terminal-title")?.textContent,
      progress: document.querySelector("#progress-count")?.textContent,
      status: document.querySelector("#receipt-status")?.textContent,
      display: document.querySelector("#explain-command")?.textContent,
      aria: document.querySelector("#explain-command")?.getAttribute("aria-label")
    }), command));
  }

  await page.locator("#learning-complete").waitFor({ state: "visible", timeout: 5000 });
  await page.waitForTimeout(100);
  const completion = await page.evaluate(() => ({
    recapCount: document.querySelectorAll("#recap-list .recap-item").length,
    progress: document.querySelector("#progress-count")?.textContent,
    announcer: document.querySelector("#announcer")?.textContent
  }));
  await page.screenshot({ path: `${evidence}/2026-11-28_harryopo_QODER-CAMPUS-20261126_05_completion.png`, fullPage: true });

  const resetFailures = [];
  for (let index = 0; index < 50; index += 1) {
    await page.locator("#reset-task").click();
    try {
      await page.locator('#terminal-mount[data-state="ready"]').waitFor({ state: "visible", timeout: 5000 });
      const progress = await page.locator("#progress-count").textContent();
      if (progress !== "3 / 3 已完成") resetFailures.push({ index, reason: `unexpected progress: ${progress}` });
    } catch (error) {
      resetFailures.push({ index, reason: error.message });
      break;
    }
  }

  await input.pressSequentially("touch /tmp/shelllab-reset-sentinel");
  await input.press("Enter");
  await waitForReceiptCommand("touch /tmp/shelllab-reset-sentinel");
  await page.locator("#receipt-status").filter({ hasText: "未通过" }).waitFor({ state: "visible", timeout: 5000 });
  await page.locator("#reset-task").click();
  await page.locator('#terminal-mount[data-state="ready"]').waitFor({ state: "visible", timeout: 5000 });
  await input.pressSequentially("ls /tmp/shelllab-reset-sentinel");
  await input.press("Enter");
  await waitForReceiptCommand("ls /tmp/shelllab-reset-sentinel");
  await page.locator("#receipt-status").filter({ hasText: "未通过" }).waitFor({ state: "visible", timeout: 5000 });
  await page.locator("#terminal-mount").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/2026-11-28_harryopo_QODER-CAMPUS-20261126_07_reset-sentinel.png`, fullPage: true });

  const responsive = [];
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(50);
    responsive.push(await page.evaluate((viewportWidth) => {
      const visibleButtons = [...document.querySelectorAll("button")].filter((button) => button.getClientRects().length > 0);
      return {
        width: viewportWidth,
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        minButtonHeight: Math.min(...visibleButtons.map((button) => button.getBoundingClientRect().height))
      };
    }, width));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#workspace").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/2026-11-28_harryopo_QODER-CAMPUS-20261126_06_mobile-terminal.png`, fullPage: false });

  await page.evaluate(() => {
    window.__shelllabReceiptEvents = [];
    const status = document.querySelector("#receipt-status");
    const command = document.querySelector("#explain-command");
    const observer = new MutationObserver(() => {
      window.__shelllabReceiptEvents.push({ command: command.textContent, status: status.textContent });
    });
    observer.observe(status, { childList: true, subtree: true, characterData: true });
    observer.observe(command, { childList: true, subtree: true, characterData: true });
    window.__shelllabReceiptObserver = observer;
  });
  await input.focus();
  await input.pressSequentially("/root");
  await input.press("Enter");
  await input.pressSequentially("uptime");
  await input.press("Enter");
  await page.waitForFunction(() => {
    const events = window.__shelllabReceiptEvents || [];
    return events.some((event) => event.command === "/root" && event.status === "未通过")
      && events.some((event) => event.command === "uptime" && event.status === "已执行");
  }, null, { timeout: 5000 });
  const pasteOrder = await page.evaluate(() => {
    window.__shelllabReceiptObserver.disconnect();
    return window.__shelllabReceiptEvents;
  });

  const timeoutContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const timeoutPage = await timeoutContext.newPage();
  let timeoutHeadSeen = false;
  await timeoutPage.route("**/assets/vendor/v86/v86.wasm", async (route) => {
    if (route.request().method() === "HEAD") {
      timeoutHeadSeen = true;
      return;
    }
    await route.continue();
  });
  const timeoutStarted = Date.now();
  await timeoutPage.goto(`${base}?probe=preflight-timeout-${Date.now()}`, { waitUntil: "domcontentloaded" });
  await timeoutPage.locator("#runtime-status").filter({ hasText: "资源预检超时" }).waitFor({ state: "visible", timeout: 15000 });
  const preflightTimeout = {
    headSeen: timeoutHeadSeen,
    elapsedMs: Date.now() - timeoutStarted,
    status: await timeoutPage.locator("#runtime-status").textContent(),
    retryVisible: await timeoutPage.locator("#retry-runtime").isVisible()
  };
  await timeoutContext.close();

  const missingContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const missingPage = await missingContext.newPage();
  await missingPage.route("**/assets/vendor/v86/v86.wasm", async (route) => {
    if (route.request().method() === "HEAD") {
      await route.fulfill({ status: 404, body: "" });
      return;
    }
    await route.continue();
  });
  await missingPage.goto(`${base}?probe=missing-wasm-${Date.now()}`, { waitUntil: "domcontentloaded" });
  await missingPage.locator("#runtime-status").filter({ hasText: "HTTP 404" }).waitFor({ state: "visible", timeout: 5000 });
  const missingWasm = {
    status: await missingPage.locator("#runtime-status").textContent(),
    retryVisible: await missingPage.locator("#retry-runtime").isVisible()
  };
  await missingContext.close();

  const constructorContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const constructorPage = await constructorContext.newPage();
  await constructorPage.route("**/assets/vendor/v86/libv86.js", (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "window.V86 = class { constructor() { throw new Error('probe constructor failure'); } };"
  }));
  await constructorPage.goto(`${base}?probe=constructor-failure-${Date.now()}`, { waitUntil: "domcontentloaded" });
  await constructorPage.locator("#runtime-status").filter({ hasText: "probe constructor failure" }).waitFor({ state: "visible", timeout: 5000 });
  const constructorFailure = {
    status: await constructorPage.locator("#runtime-status").textContent(),
    retryVisible: await constructorPage.locator("#retry-runtime").isVisible()
  };
  await constructorContext.close();

  return {
    runtime,
    focusAfterTaskClick,
    focusAfterCommand,
    hint,
    wrongCommand,
    commandResults,
    completion,
    resets: { requested: 50, ready: 50 - resetFailures.length, progressPreserved: 50 - resetFailures.length, failures: resetFailures },
    resetSentinel: {
      created: "touch /tmp/shelllab-reset-sentinel",
      checkedAfterReset: "ls /tmp/shelllab-reset-sentinel",
      screenshot: "05-作品材料/04-功能截图/harryopo/2026-11-28/2026-11-28_harryopo_QODER-CAMPUS-20261126_07_reset-sentinel.png",
      automatedOutputAssertion: false
    },
    responsive,
    pasteOrder,
    failurePaths: { preflightTimeout, missingWasm, constructorFailure },
    consoleErrors,
    pageErrors
  };
}
