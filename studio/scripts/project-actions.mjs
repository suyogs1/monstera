// The Project Actions menu of the top bar (Export, Import, Template, Recovery, Reset) is a collapsed <details> popover. Playwright acts
// only on visible elements, so a script opens it for one interaction and closes it again so the popover never covers later clicks.
export async function projectActions(page, interact) {
  const set = (open) => page.evaluate((o) => { const d = document.querySelector("details.project-actions-dropdown"); if (d) d.open = o; }, open);
  await set(true);
  try { return await interact(); } finally { await set(false); }
}
// Opens every collapsed <details> that encloses the element `selector` names (Dashboard rename form, project bundle), so it is visible.
export async function reveal(page, selector) {
  await page.waitForSelector(selector, { state: "attached", timeout: 15000 });
  await page.evaluate((s) => { for (let d = document.querySelector(s)?.closest("details"); d; d = d.parentElement?.closest("details")) d.open = true; }, selector);
}