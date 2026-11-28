async (page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:4173/?probe=terminal-lastline-${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.locator('#terminal-mount[data-state="awaiting-login"]').waitFor({ state: "visible", timeout: 45000 });
  await page.waitForTimeout(5000);
  const input = page.locator("#terminal-mount .xterm-helper-textarea");
  await input.pressSequentially("root");
  await input.press("Enter");
  await page.locator('#terminal-mount[data-state="ready"]').waitFor({ state: "visible", timeout: 30000 });
  await input.pressSequentially("uptime");
  await input.press("Enter");
  await page.waitForTimeout(500);
  const geometry = await page.evaluate(() => {
    const mount = document.querySelector("#terminal-mount").getBoundingClientRect();
    const screen = document.querySelector("#terminal-mount .xterm-screen").getBoundingClientRect();
    const rows = [...document.querySelectorAll("#terminal-mount .xterm-rows > div")];
    const lastRow = rows.at(-1).getBoundingClientRect();
    return {
      mountBottom: mount.bottom,
      mountRight: mount.right,
      screenBottom: screen.bottom,
      screenRight: screen.right,
      lastRowBottom: lastRow.bottom,
      lastRowText: rows.at(-1).textContent
    };
  });
  if (geometry.screenBottom > geometry.mountBottom + 1 || geometry.screenRight > geometry.mountRight + 1 || geometry.lastRowBottom > geometry.mountBottom + 1) {
    throw new Error(`terminal last row is clipped: ${JSON.stringify(geometry)}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const mobile = await page.evaluate(() => {
    const mount = document.querySelector("#terminal-mount").getBoundingClientRect();
    const screen = document.querySelector("#terminal-mount .xterm-screen").getBoundingClientRect();
    const rows = [...document.querySelectorAll("#terminal-mount .xterm-rows > div")];
    const lastRow = rows.at(-1).getBoundingClientRect();
    return {
      mountBottom: mount.bottom,
      mountRight: mount.right,
      screenBottom: screen.bottom,
      screenRight: screen.right,
      lastRowBottom: lastRow.bottom,
      rowCount: rows.length
    };
  });
  if (mobile.screenBottom > mobile.mountBottom + 1 || mobile.screenRight > mobile.mountRight + 1 || mobile.lastRowBottom > mobile.mountBottom + 1) {
    throw new Error(`mobile terminal last row is clipped: ${JSON.stringify(mobile)}`);
  }
  return { desktop: geometry, mobile };
}
