async (page) => {
  await page.goto(`http://127.0.0.1:4173/?probe=nudge-variables-${Date.now()}`, { waitUntil: "domcontentloaded" });
  const before = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const rail = getComputedStyle(document.querySelector(".task-rail"));
    const workspace = getComputedStyle(document.querySelector(".workspace"));
    const pack = getComputedStyle(document.querySelector("#open-pack"));
    return {
      background: body.backgroundColor,
      foreground: body.color,
      radius: rail.borderRadius,
      gap: workspace.columnGap,
      fontSize: body.fontSize,
      motion: pack.transitionDuration
    };
  });
  await page.evaluate(() => {
    const root = document.documentElement;
    root.style.setProperty("--site-bg", "rgb(1, 2, 3)");
    root.style.setProperty("--site-fg", "rgb(4, 5, 6)");
    root.style.setProperty("--site-radius", "99px");
    root.style.setProperty("--site-space", "2");
    root.style.setProperty("--site-type", "2");
    root.style.setProperty("--site-motion", "2");
  });
  const after = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const rail = getComputedStyle(document.querySelector(".task-rail"));
    const workspace = getComputedStyle(document.querySelector(".workspace"));
    const pack = getComputedStyle(document.querySelector("#open-pack"));
    return {
      background: body.backgroundColor,
      foreground: body.color,
      radius: rail.borderRadius,
      gap: workspace.columnGap,
      fontSize: body.fontSize,
      motion: pack.transitionDuration
    };
  });
  await page.evaluate(() => {
    const root = document.documentElement;
    for (const name of ["bg", "fg", "radius", "space", "type", "motion"]) root.style.removeProperty(`--site-${name}`);
  });
  const checks = {
    appearance: after.background === "rgb(1, 2, 3)" && after.foreground === "rgb(4, 5, 6)",
    radius: after.radius === "99px",
    spacing: before.gap !== after.gap,
    typography: before.fontSize !== after.fontSize,
    motion: before.motion !== after.motion
  };
  if (Object.values(checks).some((value) => !value)) throw new Error(`Nudge variables not consumed: ${JSON.stringify({ checks, before, after })}`);
  return { checks, before, after };
}
