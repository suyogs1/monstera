// UI-level acceptance checks, run by acceptance.mjs against the production build.
// Every check observes the rendered page; edits go through the same store the controls use.
import { readFileSync } from "node:fs";

const OFFICIAL = { id: "pumpkin-blaster", name: "Pumpkin Blaster" };

export default async function ui({ page, origin, check, committed, TEMPLATES }) {
  const text = async (sel) => (await page.locator(sel).first().textContent())?.trim() ?? "";
  const settled = () => page.waitForFunction(() => document.querySelector('[data-testid="validation-status"]')?.textContent?.startsWith("Checking") === false, null, { timeout: 15000 });
  const edit = async (path, value) => { await page.evaluate(([p, v]) => window.session.store.set(p, v), [path, value]); await settled(); };
  const open = async (id) => { await page.evaluate((h) => { window.location.hash = h; }, `/${id}`); await page.waitForTimeout(50); };

  // ---- shell and validation
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.ready === true);
  await settled();
  check("Studio starts on an official game and shows the engine's verdict", (await text('[data-testid="project-name"]')).includes(OFFICIAL.name) &&
    (await text('[data-testid="validation-status"]')).startsWith("Valid"), await text('[data-testid="validation-status"]'));

  // ---- Spec view
  await open("spec");
  const shownSha = (await text('[data-testid="spec-sha"]'));
  const engineSha = await page.evaluate(() => window.session.store.getState().validation.sha256);
  check("Spec view shows the engine's SHA-256 of the canonical specification", shownSha === engineSha, shownSha);

  // ---- export of an unmodified template is the committed file (R2.1 / AC3)
  const exportBytes = async () => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="export-button"]')]);
    return readFileSync(await dl.path()).toString("utf8");
  };
  check("export of an unedited template equals the committed file byte for byte", (await exportBytes()) === committed[OFFICIAL.id]);

  // ---- every template loads through the picker
  for (const t of TEMPLATES) {
    await page.selectOption('[data-testid="template-select"]', t.id);
    await settled();
    const exported = await exportBytes();
    check(`template ${t.id}: loads valid and exports the committed file`, exported === committed[t.id] &&
      (await text('[data-testid="validation-status"]')).startsWith("Valid"));
  }
  const groups = await page.$$eval('[data-testid="template-select"] optgroup', (g) => g.map((x) => `${x.label}: ${[...x.querySelectorAll("option")].map((o) => o.value).join(",")}`));
  check("Lantern Run is listed apart from the official games and labelled as a Kiro-authored sample",
    groups.length === 2 && groups[0].startsWith("Official games") && groups[0].includes("pumpkin-blaster,trick-or-treat-rush") &&
    groups[1].includes("Kiro-authored") && groups[1].endsWith("lantern-run"), groups.join(" | "));

  // ---- edit, validate, revert
  await page.selectOption('[data-testid="template-select"]', OFFICIAL.id);
  await settled();
  const original = await page.evaluate(() => window.session.store.getState().validation.sha256);
  await edit(["game", "runtime", "lives"], 9);
  const editedSha = await page.evaluate(() => window.session.store.getState().validation.sha256);
  check("an edit is validated by the engine and changes the SHA-256", editedSha && editedSha !== original && (await text('[data-testid="project-name"]')).includes("edited"));
  await edit(["game", "runtime", "lives"], 5);
  const revertedSha = await page.evaluate(() => window.session.store.getState().validation.sha256);
  check("reverting the edit returns the original SHA-256 (R2.2)", revertedSha === original && !(await text('[data-testid="project-name"]')).includes("edited"));

  // ---- invalid edit: issues listed, export disabled, issue navigates
  await edit(["game", "runtime", "lives"], 0);
  check("an invalid edit lists the engine's issues and disables export",
    (await text('[data-testid="validation-status"]')).includes("issue") && (await page.locator('[data-testid="issues"] li').count()) >= 1 &&
    (await page.locator('[data-testid="export-button"]').isDisabled()));
  await edit(["game", "runtime", "lives"], 5);

  // ---- persistence across reload
  await edit(["game", "runtime", "lives"], 7);
  await page.reload();
  await page.waitForFunction(() => window.ready === true);
  await settled();
  const restored = await page.evaluate(() => window.session.store.getState().doc.game.runtime.lives);
  check("the draft survives a reload (localStorage) and is re-validated by the engine", restored === 7 && (await text('[data-testid="project-name"]')).includes("edited"));
  page.once("dialog", (d) => d.accept());
  await page.click('[data-testid="reset-button"]');
  await page.waitForFunction(() => window.session.store.getState().doc.game.runtime.lives === 5);
  await settled();
  check("Reset returns to the template's exact SHA-256", (await page.evaluate(() => window.session.store.getState().validation.sha256)) === original);

  // ---- import: valid file loads, strict-JSON violation is refused with the engine's message
  const importFile = async (name, body) => {
    await page.setInputFiles('[data-testid="import-input"]', { name, mimeType: "application/json", buffer: Buffer.from(body, "utf8") });
    await page.waitForTimeout(400);
  };
  await importFile("lantern.json", committed["lantern-run"]);
  await settled();
  check("importing a spec file loads it and the engine validates it", (await page.evaluate(() => window.session.store.getState().validation?.ok)) === true &&
    (await page.evaluate(() => window.session.store.getState().baseline.group)) === "import");
  await importFile("bad.json", '{"specVersion": 4, "specVersion": 4}');
  check("importing a file with a duplicate key is refused and the draft is kept",
    (await page.evaluate(() => window.session.store.getState().baseline.label)) === "lantern.json" &&
    (await page.locator(".notice").first().textContent()).includes("duplicate key"));

  // ---- import refusals keep the draft and say why
  const refused = async (label, name, buffer, expectText) => {
    await page.setInputFiles('[data-testid="import-input"]', { name, mimeType: "application/json", buffer });
    await page.waitForTimeout(400);
    const kept = (await page.evaluate(() => window.session.store.getState().baseline.label)) === "lantern.json";
    const notice = (await page.locator(".notice").first().textContent()) ?? "";
    check(`importing ${label} is refused, names the reason and keeps the draft`, kept && notice.includes(expectText), notice.slice(0, 110));
  };
  await refused("JSON null", "n.json", Buffer.from("null"), "JSON object");
  await refused("a JSON array", "a.json", Buffer.from("[]"), "JSON object");
  await refused("a file with a UTF-8 byte order mark (as the CLI does)", "bom.json", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]), "byte order mark");
  await refused("a file that is not valid UTF-8", "bin.json", Buffer.from([0xff, 0xfe, 0x7b]), "not valid UTF-8");

  // =================================================================== Project Brain
  await page.selectOption('[data-testid="template-select"]', OFFICIAL.id);
  await page.waitForFunction(() => window.session.store.getState().baseline.label === "pumpkin-blaster");
  await settled();
  const sel = (path) => `[data-path="${path}"]`;
  const doc = () => page.evaluate(() => window.session.store.getState().doc);
  const sha = () => page.evaluate(() => window.session.store.getState().validation?.sha256);
  const original2 = await sha();

  // ---- schema coverage against the rendered UI
  const sections = ["overview", "platforms", "gameplay", "entities", "rules", "spawns", "presentation"];
  const rendered = { controls: new Set(), readonly: new Set() };
  for (const s of sections) {
    await open(s);
    const found = await page.$$eval("[data-pattern]", (els) => els.map((e) => [e.getAttribute("data-pattern"), e.tagName.toLowerCase()]));
    for (const [p, tag] of found) (tag === "output" ? rendered.readonly : rendered.controls).add(p);
  }
  const coverage = await page.evaluate(() => window.coverage);
  const editable = Object.entries(coverage).filter(([, v]) => v.role === "editable").map(([k]) => k).sort();
  const nonEditable = Object.entries(coverage).filter(([, v]) => v.role !== "editable").map(([k]) => k).sort();
  const missing = editable.filter((p) => !rendered.controls.has(p));
  const surplus = [...rendered.controls].filter((p) => !editable.includes(p));
  check("every leaf classified editable has a rendered control, and no control is bound to anything else",
    missing.length === 0 && surplus.length === 0, `${editable.length} editable leaves; missing: ${missing.join(", ") || "none"}; surplus: ${surplus.join(", ") || "none"}`);
  const roMissing = nonEditable.filter((p) => !rendered.readonly.has(p));
  check("read-only and engine-managed leaves are shown as read-only values, never as controls",
    roMissing.length === 0 && [...rendered.readonly].every((p) => nonEditable.includes(p)), `${nonEditable.join(", ")}`);

  // ---- every control has an accessible name
  await open("entities");
  const unnamed = await page.$$eval("main input, main select, main textarea", (els) =>
    els.filter((e) => !(e.labels && e.labels.length) && !e.getAttribute("aria-label")).map((e) => e.getAttribute("data-path") ?? e.outerHTML.slice(0, 60)));
  check("every control on the Entities page has an accessible name", unnamed.length === 0, unnamed.join(", "));

  // ---- units: typed game units are stored as exact raw integers
  const width = sel("$.game.runtime.kinds[0].width");
  await page.fill(width, "9");
  let d = await doc();
  check("typing 9 units stores raw 589824 and shows the raw value", d.game.runtime.kinds[0].width === 589824 &&
    (await page.locator(".card").first().locator(".rawchip").first().textContent()).includes("589824"));
  await page.fill(width, "0.1");
  d = await doc();
  check("typing 0.1 stores the nearest raw value 6554 (ties away from zero)", d.game.runtime.kinds[0].width === 6554);
  await page.fill(width, "12abc");
  d = await doc();
  check("text that is not a number is not applied and is flagged", d.game.runtime.kinds[0].width === 6554 &&
    (await page.locator(".card").first().locator(".issue-inline").first().textContent()).includes("not applied"));
  const tplWidth = (JSON.parse(committed[OFFICIAL.id])).game.runtime.kinds[0].width;
  await page.fill(width, String(tplWidth / 65536));
  await settled();
  check("typing the template's own value returns the exact raw integer and original SHA-256", (await doc()).game.runtime.kinds[0].width === tplWidth && (await sha()) === original2, `${tplWidth} raw`);

  // ---- raw mode edits raw integers directly
  await page.locator('label:has-text("Raw (Q16.16)") input').check();
  await page.waitForFunction(([s, v]) => document.querySelector(s)?.value === v, [width, String(tplWidth)], { timeout: 3000 }).catch(() => {});
  const shown = await page.inputValue(width);
  check("raw display mode shows the stored integer", shown === String(tplWidth), shown);
  await page.locator('label:has-text("Game units") input').check();

  // ---- kind rename cascades; delete is blocked while referenced
  const beforeRename = await doc();
  const idField = sel("$.game.runtime.kinds[1].id"); // bullet
  await page.fill(idField, "shot");
  await page.press(idField, "Enter");
  await settled();
  d = await doc();
  const stillBullet = JSON.stringify(d).includes('"bullet"');
  check("renaming a kind rewrites its definition and every reference (tapKind, collisions)",
    d.game.runtime.kinds[1].id === "shot" && d.game.input.tapKind === "shot" && !stillBullet &&
    d.game.runtime.collisions[0].a === "shot" && d.game.runtime.collisions[1].a === "shot", `tapKind=${d.game.input.tapKind}`);
  check("after the cascade the draft is still valid", (await text('[data-testid="validation-status"]')).startsWith("Valid"));
  await page.fill(idField, "bat"); // duplicate
  await page.press(idField, "Enter");
  check("renaming onto an existing id is refused with a message and changes nothing",
    (await doc()).game.runtime.kinds[1].id === "shot" && (await page.locator(".card").nth(1).locator(".issue-inline").first().textContent()).includes("already"));
  await page.fill(idField, "bullet");
  await page.press(idField, "Enter");
  await settled();
  check("renaming back restores the original SHA-256", (await sha()) === original2 && JSON.stringify(await doc()) === JSON.stringify(beforeRename));

  const removeButtons = page.locator('.card:has([data-path="$.game.runtime.kinds[2].id"]) button.danger');
  await removeButtons.first().click();
  d = await doc();
  check("removing a kind that is still used is blocked and lists where it is used",
    d.game.runtime.kinds.length === 6 && (await page.locator(".blocked li").count()) > 0, `${await page.locator(".blocked li").count()} references`);

  // ---- add and remove an unreferenced kind
  await page.click('button:has-text("Add kind")');
  d = await doc();
  check("Add kind appends a complete kind", d.game.runtime.kinds.length === 7 && Object.keys(d.game.runtime.kinds[6]).length === 8);
  await page.locator('.card:has([data-path="$.game.runtime.kinds[6].id"]) button.danger').click();
  await settled();
  check("removing the unreferenced kind restores the original SHA-256", (await sha()) === original2);

  // ---- engine verdict appears at the field, and the issue list navigates to it
  await open("presentation");
  const primary = sel("$.game.palette.primary");
  await page.fill(primary, "#120A1F");
  await settled();
  check("a semantic engine issue (palette contrast) is shown at its field",
    (await page.locator(".field:has([data-path='$.game.palette.primary']) .issue-inline").first().textContent()).includes("contrast"));
  await open("spec");
  await page.locator('[data-testid="issues"] button').first().click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-path") === "$.game.palette.primary", null, { timeout: 5000 });
  check("clicking the issue opens Presentation and focuses the palette control", true);
  await page.fill(primary, JSON.parse(committed[OFFICIAL.id]).game.palette.primary);
  await settled();
  check("fixing the colour makes the draft valid again with the original SHA-256", (await sha()) === original2);

  // ---- Overview and Spawns are derived from the spec
  await open("overview");
  const sentences = await page.locator('[data-testid="rule-sentences"] li').allTextContents();
  check("Overview states the collision rules in words", sentences[0] === "bullet touches pumpkin: score +10; bullet and pumpkin vanish", sentences[0]);
  await page.locator(".tile:has-text('World')").click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-path") === "$.game.world.width", null, { timeout: 4000 }).catch(() => {});
  check("the World tile opens Gameplay and focuses the world width control", (await page.evaluate(() => document.activeElement?.getAttribute("data-path"))) === "$.game.world.width");
  await open("overview");
  await page.locator(".tile:has-text('Entity kinds')").click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-path") === "$.game.runtime.kinds[0]", null, { timeout: 4000 }).catch(() => {});
  check("the Entity kinds tile opens Entities and focuses the first kind", (await page.evaluate(() => document.activeElement?.getAttribute("data-path"))) === "$.game.runtime.kinds[0]");

  await open("rules");
  check("kind pickers carry no identifier-format help text", (await page.locator('.field:has([data-path="$.game.runtime.collisions[0].a"]) .help').count()) === 0);
  await open("gameplay");
  check("a picker's own description is kept (tap spawns)", (await page.locator('.field:has([data-path="$.game.input.tapKind"]) .help').first().textContent()).includes("spawned by a tap"));

  await open("spawns");
  check("Spawns shows one timeline row per spawner", (await page.locator('[data-testid="spawn-timeline"] g').count()) === 4);
  const overlap = await page.$$eval('[data-testid="spawn-timeline"] g', (rows) => rows.map((g) => {
    const label = g.querySelector("text").getBBox();
    const marks = [...g.querySelectorAll("rect")].map((r) => r.getBBox().x);
    return marks.length && label.x + label.width > Math.min(...marks) ? `label ends ${Math.round(label.x + label.width)} > first mark ${Math.round(Math.min(...marks))}` : null;
  }).filter(Boolean));
  check("timeline row labels do not overlap spawn marks", overlap.length === 0, overlap.join("; "));

  // ---- Developer Integration: generated from the repository, never implies a connection
  await open("integration");
  const { readdirSync, readFileSync: rf } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const repo = join(process.cwd(), "..");
  const count = (dir, ext) => readdirSync(join(repo, dir)).filter((n) => n.endsWith(ext)).length;
  const heading = async (prefix) => (await page.locator(`h3:text-matches("^${prefix}")`).first().textContent()) ?? "";
  const n = (s) => Number(/\((\d+)\)/.exec(s)?.[1]);
  const hookCount = readdirSync(join(repo, ".kiro/hooks")).filter((f) => f.endsWith(".json"))
    .reduce((a, f) => { const j = JSON.parse(rf(join(repo, ".kiro/hooks", f), "utf8")); return a + (Array.isArray(j.hooks) ? j.hooks.length : 1); }, 0);
  const toolCount = (rf(join(repo, "tools/monstera-mcp/server.py"), "utf8").match(/@server\.tool\(/g) ?? []).length;
  const counts = {
    agents: [n(await heading("Agents")), count(".kiro/agents", ".json")],
    "MCP tools": [n(await heading("MCP server")), toolCount],
    steering: [n(await heading("Steering")), count(".kiro/steering", ".md")],
    hooks: [n(await heading("Hooks")), hookCount],
    workflows: [n(await heading("Workflows")), count(".kiro/workflows", ".workflow.json")],
    prompts: [n(await heading("Repository prompts")), count(".kiro/prompts", ".md")],
  };
  check("Developer Integration lists exactly what the repository contains (counts read independently from the files)",
    Object.values(counts).every(([shown, actual]) => shown === actual && actual > 0), JSON.stringify(counts));
  const short = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: repo }).toString().trim();
  check("the inventory is stamped with the commit it was read at", (await text('[data-testid="inventory-stamp"]')).includes(short), short);
  const notice = await text('[data-testid="integration-notice"]');
  check("the page states that Studio is not connected to Kiro and shares only the spec file",
    notice.includes("Studio is not connected to Kiro") && notice.includes("only thing the two share is the specification file"));
  const pageText = (await page.locator("main").innerText()).replace("Studio is not connected to Kiro", "");
  check("no wording implies a live Kiro connection, status or session", !/connect|online|live |synced|session active/i.test(pageText.replace(/Kiro sessions/g, "").replace(/cannot see Kiro\s+sessions/g, "")), "");
  const prompts = await page.locator(".prompt pre").allTextContents();
  check("handoff prompts name the draft's own spec path and existing MCP tools", prompts.length === 2 && prompts.every((p) => p.includes("spec/samples/pumpkin-blaster/monstera.spec.json")) && prompts[0].includes("validate_spec"));
  check("agent game-author and tool validate_spec appear in the inventory", (await page.locator("main").innerText()).includes("game-author") && (await page.locator('th code:text("validate_spec")').count()) === 1);

  // ---- Studio has no Kiro/chat/build affordances
  const body = (await page.locator("body").innerText()).toLowerCase();
  check("no build button and no chat input exist", !(await page.locator('button:has-text("Build")').count()) && !(await page.locator("textarea").count()) && !body.includes("ask kiro"));
}
