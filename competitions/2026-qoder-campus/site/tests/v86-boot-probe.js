async (page) => {
  const browser = page.context().browser();
  const base = "http://127.0.0.1:4173/";
  const viewport = { width: 1440, height: 900 };

  async function waitUntilReady(target, startedAt) {
    await target.getByText("Welcome to Buildroot", { exact: false }).first().waitFor({ state: "visible", timeout: 30000 });
    await target.locator("#terminal-mount").click();
    await target.locator("#terminal-mount .xterm-helper-textarea").pressSequentially("root");
    await target.locator("#terminal-mount .xterm-helper-textarea").press("Enter");
    await target.getByText("Linux 已就绪", { exact: false }).first().waitFor({ state: "visible", timeout: 30000 });
    return Date.now() - startedAt;
  }

  async function readMemory(target, context) {
    const heap = await target.evaluate(() => {
      const memory = performance.memory;
      if (!memory) return null;
      return {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit
      };
    });
    const cdp = await context.newCDPSession(target);
    const counters = await cdp.send("Memory.getDOMCounters");
    return { heap, counters };
  }

  const cold = [];
  for (let index = 0; index < 5; index += 1) {
    const context = await browser.newContext({ viewport });
    const target = await context.newPage();
    const errors = [];
    target.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const startedAt = Date.now();
    await target.goto(`${base}?probe=cold-${Date.now()}-${index}`, { waitUntil: "domcontentloaded" });
    const elapsed = await waitUntilReady(target, startedAt);
    cold.push({ elapsed, errors, memory: await readMemory(target, context) });
    await context.close();
  }

  const warm = [];
  const context = await browser.newContext({ viewport });
  const target = await context.newPage();
  await target.goto(`${base}?probe=warmup-${Date.now()}`, { waitUntil: "domcontentloaded" });
  await waitUntilReady(target, Date.now());
  for (let index = 0; index < 5; index += 1) {
    const startedAt = Date.now();
    await target.reload({ waitUntil: "domcontentloaded" });
    warm.push(await waitUntilReady(target, startedAt));
  }
  await context.close();

  return { cold, warm };
}
