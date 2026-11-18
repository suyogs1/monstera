import {
  addPlacement, addStep, addWave, removePlacement, removeStep, removeWave, renameLevel, setPlacement, setStep, setWave, type LevelOpResult,
} from "../derive/levelOps";
import type { DifficultyStep, Level, LevelsManifest, Placement, Wave } from "../project/manifests";
import { NumInput } from "./NumInput";

export type Act = (result: LevelOpResult, field: string) => void;
type Num = "fixed" | "int";

function KindPick({ label, value, kinds, onChange }: { label: string; value: string; kinds: string[]; onChange(k: string): void }) {
  const unknown = value !== "" && !kinds.includes(value);
  return (
    <select aria-label={label} value={value} aria-invalid={unknown} onChange={(e) => onChange(e.target.value)}>
      {unknown && <option value={value}>{value} (no such kind)</option>}
      {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
    </select>
  );
}
/** Placements, spawn waves and difficulty steps of ONE level. Every control goes through levelOps, which the manifest validator checks. */
export function LevelEditor({ levels, level, kinds, act }: { levels: LevelsManifest; level: Level; kinds: string[]; act: Act }) {
  const first = kinds[0] ?? "";
  const key = (...p: string[]) => `${level.id}.${p.join(".")}`;
  const num = (label: string, value: number, kind: Num, commit: (n: number) => LevelOpResult, field: string) => (
    <NumInput label={label} value={value} kind={kind} onCommit={(n) => act(commit(n), field)} />
  );
  const placement = (p: Placement) => {
    const set = (patch: Partial<Omit<Placement, "id">>) => setPlacement(levels, level.id, p.id, patch);
    const f = key("placements", p.id);
    return (
      <tr key={p.id} data-testid={`placement-${p.id}`}>
        <td><code>{p.id}</code></td>
        <td><KindPick label={`${p.id} kind`} value={p.kind} kinds={kinds} onChange={(k) => act(set({ kind: k }), `${f}.kind`)} /></td>
        <td>{num(`${p.id} x`, p.x, "fixed", (n) => set({ x: n }), `${f}.x`)}</td>
        <td>{num(`${p.id} y`, p.y, "fixed", (n) => set({ y: n }), `${f}.y`)}</td>
        <td><input type="checkbox" aria-label={`${p.id} controlled`} checked={p.controlled} onChange={(e) => act(set({ controlled: e.target.checked }), `${f}.controlled`)} /></td>
        <td><button type="button" aria-label={`Remove placement ${p.id}`} onClick={() => act(removePlacement(levels, level.id, p.id), `${f}.remove`)}>Remove</button></td>
      </tr>
    );
  };
  const wave = (w: Wave) => {
    const set = (patch: Partial<Omit<Wave, "id">>) => setWave(levels, level.id, w.id, patch);
    const f = key("waves", w.id);
    const n = (label: string, field: keyof Omit<Wave, "id" | "kind" | "stream">, kind: Num) => (
      <td>{num(`${w.id} ${label}`, w[field], kind, (v) => set({ [field]: v }), `${f}.${field}`)}</td>
    );
    return (
      <tr key={w.id} data-testid={`wave-${w.id}`}>
        <td><code>{w.id}</code></td>
        <td><KindPick label={`${w.id} kind`} value={w.kind} kinds={kinds} onChange={(k) => act(set({ kind: k }), `${f}.kind`)} /></td>
        {n("start tick", "startTick", "int")}{n("interval ticks", "intervalTicks", "int")}
        {n("x min", "xMin", "fixed")}{n("x max", "xMax", "fixed")}{n("y min", "yMin", "fixed")}{n("y max", "yMax", "fixed")}
        {n("vx", "vx", "fixed")}{n("vy", "vy", "fixed")}
        <td><button type="button" aria-label={`Remove wave ${w.id}`} onClick={() => act(removeWave(levels, level.id, w.id), `${f}.remove`)}>Remove</button></td>
      </tr>
    );
  };
  const step = (s: DifficultyStep) => {
    const set = (patch: Partial<Omit<DifficultyStep, "id">>) => setStep(levels, level.id, s.id, patch);
    const f = key("difficulty", s.id);
    const n = (label: string, field: "atTick" | "intervalTicks" | "vx" | "vy", kind: Num) => (
      <td>{num(`${s.id} ${label}`, s[field], kind, (v) => set({ [field]: v }), `${f}.${field}`)}</td>
    );
    return (
      <tr key={s.id} data-testid={`step-${s.id}`}>
        <td><code>{s.id}</code></td>
        <td>
          <select aria-label={`${s.id} wave`} value={s.waveId} onChange={(e) => act(set({ waveId: e.target.value }), `${f}.waveId`)}>
            {level.waves.map((w) => <option key={w.id} value={w.id}>{w.id}</option>)}
            {!level.waves.some((w) => w.id === s.waveId) && <option value={s.waveId}>{s.waveId} (no such wave)</option>}
          </select>
        </td>
        {n("at tick", "atTick", "int")}{n("interval ticks", "intervalTicks", "int")}{n("vx", "vx", "fixed")}{n("vy", "vy", "fixed")}
        <td><button type="button" aria-label={`Remove step ${s.id}`} onClick={() => act(removeStep(levels, level.id, s.id), `${f}.remove`)}>Remove</button></td>
      </tr>
    );
  };
  return (
    <div data-testid="level-editor" data-level={level.id}>
      <div className="field">
        <label htmlFor="level-name">Name</label>
        <input id="level-name" type="text" key={level.id} defaultValue={level.name} maxLength={60}
          onBlur={(e) => { if (e.target.value.trim() !== level.name) act(renameLevel(levels, level.id, e.target.value), key("name")); }} />
      </div>
      <h4>Initial placements</h4>
      <table className="inv-table"><thead><tr><th>Id</th><th>Kind</th><th>x</th><th>y</th><th>Controlled</th><th /></tr></thead>
        <tbody>{level.placements.map(placement)}</tbody></table>
      <p className="actions small"><button type="button" data-testid="placement-add" disabled={first === ""} onClick={() => act(addPlacement(levels, level.id, first), key("placements", "add"))}>Add placement</button></p>
      <h4>Spawn waves</h4>
      <table className="inv-table"><thead><tr><th>Id</th><th>Kind</th><th>Start tick</th><th>Interval</th><th>x min</th><th>x max</th><th>y min</th><th>y max</th><th>vx</th><th>vy</th><th /></tr></thead>
        <tbody>{level.waves.map(wave)}</tbody></table>
      <p className="actions small"><button type="button" data-testid="wave-add" disabled={first === ""} onClick={() => act(addWave(levels, level.id, first), key("waves", "add"))}>Add wave</button></p>
      <h4>Difficulty steps</h4>
      <p className="muted small">Each step compiles to an additional spawner that starts later and reuses its wave&apos;s kind and ranges. The wave keeps spawning: spawners cannot stop.</p>
      <table className="inv-table"><thead><tr><th>Id</th><th>Wave</th><th>At tick</th><th>Interval</th><th>vx</th><th>vy</th><th /></tr></thead>
        <tbody>{level.difficulty.map(step)}</tbody></table>
      <p className="actions small"><button type="button" data-testid="step-add" disabled={level.waves.length === 0} onClick={() => act(addStep(levels, level.id, level.waves[0]?.id ?? ""), key("difficulty", "add"))}>Add difficulty step</button></p>
    </div>
  );
}
