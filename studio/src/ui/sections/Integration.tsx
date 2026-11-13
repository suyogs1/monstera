import { useState, type ReactNode } from "react";
import { getAt } from "../../draft/path";
import raw from "../../generated/inventory.json";
import type { Inventory } from "../../integration/types";
import { useDoc } from "../fields";

const inv = raw as unknown as Inventory;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setState("copied"); } catch { setState("failed"); }
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <button type="button" onClick={() => void copy()} aria-label={`Copy ${label}`}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed: select the text" : "Copy"}
    </button>
  );
}

function Prompt({ title, text }: { title: string; text: string }) {
  return (
    <div className="prompt">
      <div className="prompt-head"><strong>{title}</strong><CopyButton text={text} label={title} /></div>
      <pre className="plain" tabIndex={0}>{text}</pre>
    </div>
  );
}

const missing = (found: boolean, what: string): ReactNode =>
  found ? null : <strong className="issue-inline"> (not found in this commit&apos;s inventory: {what})</strong>;

export function Integration() {
  const doc = useDoc();
  const id = (doc !== null && typeof getAt(doc, ["project", "id"]) === "string" ? (getAt(doc, ["project", "id"]) as string) : "") || "<id>";
  const path = `spec/samples/${id}/monstera.spec.json`;
  const author = inv.agents.find((a) => a.name === "game-author");
  const toolNames = new Set(inv.mcp.tools.map((t) => t.name));
  const validatePrompt =
    `Validate ${path} with the monstera validate_spec tool. Do not change any file yet. ` +
    `Explain every issue in plain language and propose the smallest fix for each.`;
  const changePrompt =
    `Using the game-author agent, change the game in ${path}: <describe the change>. ` +
    `Follow .kiro/steering/10-game-authoring.md, validate with validate_spec, and show me the diff before generating anything.`;
  const c = inv.commit;

  return (
    <section aria-labelledby="integration-h" data-testid="integration">
      <header className="section-head">
        <h2 id="integration-h">Developer Integration</h2>
        <p>What this repository gives Kiro, read from the repository itself.</p>
      </header>

      <div className="callout" role="note" data-testid="integration-notice">
        <h3>Studio is not connected to Kiro</h3>
        <p>
          Kiro runs in its own IDE. It works with this repository through the steering files, agents, hooks and workflows
          listed below, and by calling the <code>monstera</code> MCP server. Studio has no channel to Kiro: it cannot see Kiro
          sessions, send it prompts or receive anything from it. The only thing the two share is the specification file.
          Export it here, or import one Kiro wrote.
        </p>
      </div>

      <section className="card" aria-labelledby="handoff-h">
        <header><h3 id="handoff-h">Handoff recipe</h3></header>
        <ol className="steps">
          <li>Make the draft valid here, then choose <strong>Export spec</strong>. You get <code>monstera.spec.json</code> in the engine&apos;s canonical form.</li>
          <li>
            In the repository, save it as <code>{path}</code>. New games go under <code>spec/samples/</code>; <code>apps/</code> holds only the two official games.
            <CopyButton text={path} label="the spec path" />
          </li>
          <li>
            Open the repository in Kiro and select the <code>game-author</code> agent{missing(Boolean(author), "agent game-author")}. Paste a prompt such as the ones below.
          </li>
          <li>
            Kiro validates and edits the spec with the MCP tools ({["validate_spec", "generate_project", "run_conformance"].map((t) => (
              <span key={t}><code>{t}</code>{missing(toolNames.has(t), t)} </span>
            ))}) and never edits generated code by hand.
          </li>
          <li>Back here, choose <strong>Import spec…</strong> and load the file Kiro wrote. The engine validates it again.</li>
        </ol>
        <Prompt title="Validate this draft" text={validatePrompt} />
        <Prompt title="Change this game" text={changePrompt} />
      </section>

      <section className="card" aria-labelledby="agents-h">
        <header><h3 id="agents-h">Agents ({inv.agents.length})</h3></header>
        <ul className="inv">
          {inv.agents.map((a) => (
            <li key={a.file}>
              <details>
                <summary><strong>{a.name}</strong> <span className="muted">{a.description}</span></summary>
                <dl className="kv">
                  <dt>File</dt><dd><code>{a.file}</code></dd>
                  <dt>Tools</dt><dd>{a.tools.join(", ") || "none listed"}{a.includesMcpJson ? " · includes the workspace MCP settings" : ""}</dd>
                  <dt>May write</dt><dd>{a.writeAllow.length ? a.writeAllow.map((p) => <code key={p}>{p} </code>) : "not restricted by a rule"}</dd>
                  <dt>May not write</dt><dd>{a.writeDeny.length ? a.writeDeny.map((p) => <code key={p}>{p} </code>) : "no deny rule"}</dd>
                  {a.shellAllow.length > 0 && (<><dt>Shell</dt><dd>{a.shellAllow.map((p) => <code key={p}>{p} </code>)}</dd></>)}
                  <dt>Reads</dt><dd>{a.resources.map((r) => <code key={r}>{r.replace("file://", "")} </code>)}</dd>
                </dl>
                <pre className="plain" tabIndex={0} aria-label={`${a.name} instructions`}>{a.prompt}</pre>
              </details>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="mcp-h">
        <header><h3 id="mcp-h">MCP server and tools ({inv.mcp.tools.length})</h3></header>
        {inv.mcp.servers.map((s) => (
          <p key={s.name}>
            Server <code>{s.name}</code>{s.disabled ? " (disabled)" : ""} starts with <code>{s.command}</code>. Calls without a prompt:{" "}
            {s.autoApprove.map((t) => <code key={t}>{t} </code>)}
          </p>
        ))}
        <table className="inv-table">
          <thead><tr><th scope="col">Tool</th><th scope="col">Access</th><th scope="col">What it does</th><th scope="col">Arguments</th></tr></thead>
          <tbody>
            {inv.mcp.tools.map((t) => (
              <tr key={t.name}>
                <th scope="row"><code>{t.name}</code></th><td>{t.access}</td><td>{t.summary}</td><td><code className="small">{t.params || "none"}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Read from <code>{inv.mcp.source}</code>. The list shows what the repository defines, not whether a server is running in your Kiro.</p>
      </section>

      <section className="card" aria-labelledby="steering-h">
        <header><h3 id="steering-h">Steering ({inv.steering.length})</h3></header>
        <table className="inv-table">
          <thead><tr><th scope="col">File</th><th scope="col">Topic</th><th scope="col">Applies</th></tr></thead>
          <tbody>
            {inv.steering.map((s) => (
              <tr key={s.file}><th scope="row"><code>{s.file.replace(".kiro/steering/", "")}</code></th><td>{s.title}</td>
                <td>{s.inclusion === "always" ? "always" : <>{s.inclusion} <code className="small">{s.pattern}</code></>}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card" aria-labelledby="hooks-h">
        <header><h3 id="hooks-h">Hooks ({inv.hooks.length})</h3></header>
        <ul className="inv">
          {inv.hooks.map((h) => (
            <li key={h.file + h.name}>
              <strong>{h.name}</strong> <span className="muted">on {h.trigger}{h.matcher ? ` · ${h.matcher}` : ""}</span>
              {h.description && <p className="small muted">{h.description}</p>}
              {h.command && <code className="small">{h.command}</code>}
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="workflows-h">
        <header><h3 id="workflows-h">Workflows ({inv.workflows.length})</h3></header>
        <ul className="inv">
          {inv.workflows.map((w) => (
            <li key={w.file}>
              <strong>{w.name}</strong> <span className="muted">{w.description}</span>
              <p className="small muted">Inputs: {w.inputs.join(", ") || "none"} · Step agents: {w.agents.join(", ") || "none"}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="prompts-h">
        <header><h3 id="prompts-h">Repository prompts ({inv.prompts.length})</h3></header>
        <ul className="inv">
          {inv.prompts.map((p) => (
            <li key={p.file}>
              <details>
                <summary>{p.title} <span className="muted small"><code>{p.file}</code></span></summary>
                <div className="prompt-head"><span /><CopyButton text={p.body} label={p.title} /></div>
                <pre className="plain" tabIndex={0}>{p.body}</pre>
              </details>
            </li>
          ))}
        </ul>
      </section>

      <p className="muted small" data-testid="inventory-stamp">
        Inventory built from {c.sha ? <>commit <code>{c.short}</code>{c.dirty ? " with uncommitted changes in the files below" : ""}{c.branch ? ` on ${c.branch}` : ""}</> : "a checkout without git information"}
        {" "}(source: {c.source}). Files read: {inv.sources.map((s) => <code key={s}>{s} </code>)}
      </p>
    </section>
  );
}
