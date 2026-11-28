async (page) => {
  const base = "http://127.0.0.1:8080/";
  const evidence = globalThis.process?.env?.SHELLLAB_EVIDENCE_DIR || "competitions/2026-qoder-campus/05-作品材料/04-功能截图/harryopo/2026-11-28";
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}?probe=card-pack-${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.locator('#terminal-mount[data-state="awaiting-login"]').waitFor({ state: "visible", timeout: 45000 });
  await page.waitForTimeout(5000);
  const input = page.locator("#terminal-mount .xterm-helper-textarea");
  await input.pressSequentially("root");
  await input.press("Enter");
  await page.locator('#terminal-mount[data-state="ready"]').waitFor({ state: "visible", timeout: 30000 });

  const catalog = await page.evaluate(() => ({
    status: document.querySelector("#catalog-status")?.textContent,
    packs: document.querySelector("#pack-count")?.textContent,
    commands: document.querySelector("#command-count")?.textContent
  }));

  await page.locator("#open-pack").click();
  await page.locator("#pack-dialog").waitFor({ state: "visible" });
  await page.waitForTimeout(450);
  const packCards = await page.locator(".pack-card").count();
  const accents = await page.locator(".pack-card").evaluateAll((cards) => [...new Set(cards.map((card) => card.dataset.accent))]);
  await page.screenshot({ path: `${evidence}/2026-11-28_harryopo_QODER-CAMPUS-20261126_02_card-pack.png`, fullPage: true });
  await page.locator("#pack-dialog").getByRole("button", { name: /磁盘容量/ }).click();
  await page.locator('#task-panel[data-open="true"]').waitFor({ state: "visible" });
  const selected = await page.evaluate(() => ({
    title: document.querySelector("#task-panel-title")?.textContent,
    goal: document.querySelector("#task-panel-goal")?.textContent,
    steps: document.querySelectorAll("#task-step-list li").length,
    accent: document.querySelector("#task-panel")?.dataset.accent
  }));

  await page.locator("#collapse-panel").click();
  const collapsed = await page.locator("#task-panel").getAttribute("data-collapsed");
  await page.locator("#collapse-panel").click();
  await page.locator("#dock-panel").click();
  const dockLeft = await page.evaluate(() => ({
    dock: document.querySelector("#task-panel")?.dataset.dock,
    workspace: document.querySelector("#workspace")?.classList.contains("dock-left")
  }));
  await page.screenshot({ path: `${evidence}/2026-11-28_harryopo_QODER-CAMPUS-20261126_03_task-panel-docked.png`, fullPage: true });
  await page.locator("#dock-panel").click();
  await page.locator("#close-panel").click();
  const tabVisible = await page.locator("#panel-tab").isVisible();
  await page.locator("#panel-tab").click();

  await page.locator("#open-pack").click();
  await page.locator("#pack-dialog").getByRole("button", { name: /网络基础/ }).click();
  await page.locator("#hint-button").click();
  await input.press("Enter");
  await page.locator("#explain-command").waitFor({ state: "visible" });
  await page.locator("#receipt-status").filter({ hasText: "已执行" }).waitFor({ state: "visible", timeout: 5000 });
  await page.waitForFunction(async () => {
    const response = await fetch("/api/progress");
    if (!response.ok) return false;
    const body = await response.json();
    return body.completed.some((item) => item.stepId === "network-ifconfig");
  }, null, { timeout: 5000 });
  const serverProgress = await page.evaluate(async () => (await (await fetch("/api/progress")).json()).completed.map((item) => item.stepId));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('#terminal-mount[data-state="awaiting-login"]').waitFor({ state: "visible", timeout: 45000 });
  await page.waitForTimeout(5000);
  await input.pressSequentially("root");
  await input.press("Enter");
  await page.locator('#terminal-mount[data-state="ready"]').waitFor({ state: "visible", timeout: 30000 });
  const hydratedTaskText = await page.locator(".task-button").nth(4).textContent();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#open-pack").click();
  await page.locator("#pack-dialog").waitFor({ state: "visible" });
  await page.waitForTimeout(450);
  const mobile = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    columns: getComputedStyle(document.querySelector("#pack-grid")).gridTemplateColumns
  }));
  await page.screenshot({ path: `${evidence}/2026-11-28_harryopo_QODER-CAMPUS-20261126_04_mobile-card-pack.png`, fullPage: false });
  await page.locator("#close-pack").click();
  await page.locator("#open-pack").click();
  await page.locator("#pack-dialog").getByRole("button", { name: /磁盘容量/ }).click();
  const mobilePanel = await page.evaluate(() => ({
    position: getComputedStyle(document.querySelector("#task-panel")).position,
    bottom: getComputedStyle(document.querySelector("#task-panel")).bottom,
    open: document.querySelector("#task-panel")?.dataset.open
  }));

  return { catalog, packCards, accents, selected, collapsed, dockLeft, tabVisible, serverProgress, hydratedTaskText, mobile, mobilePanel, errors };
}
