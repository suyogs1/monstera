import type { LevelsManifest } from "../project/manifests";

/**
 * The level list. A row's "Edit" button only changes which level the editor shows (UI state). Which level is ACTIVE is
 * chosen in the Active level region; the badge here only reports it.
 */
export function LevelList({ levels, editingId, activeId, onEdit, onAdd, onDuplicate, onMove, onDelete }: {
  levels: LevelsManifest["levels"]; editingId: string | null; activeId: string | null;
  onEdit(id: string): void; onAdd(name: string): void; onDuplicate(id: string): void; onMove(id: string, dir: -1 | 1): void; onDelete(id: string): void;
}) {
  return (
    <div data-testid="levels-list">
      <ol className="level-list">
        {levels.map((l, i) => (
          <li key={l.id} data-testid={`level-row-${l.id}`} data-editing={l.id === editingId ? "true" : undefined} data-active={l.id === activeId ? "true" : undefined}>
            <span className="level-name"><strong>{l.name}</strong> <code>{l.id}</code>{" "}
              {l.id === editingId && <span className="badge-inline">editing</span>}{" "}
              {l.id === activeId && <span className="badge-inline active">active</span>}
            </span>
            <span className="actions small">
              <button type="button" data-testid={`level-edit-${l.id}`} aria-pressed={l.id === editingId} onClick={() => onEdit(l.id)}>Edit</button>
              <button type="button" data-testid={`level-up-${l.id}`} disabled={i === 0} aria-label={`Move ${l.name} up`} onClick={() => onMove(l.id, -1)}>Up</button>
              <button type="button" data-testid={`level-down-${l.id}`} disabled={i === levels.length - 1} aria-label={`Move ${l.name} down`} onClick={() => onMove(l.id, 1)}>Down</button>
              <button type="button" data-testid={`level-duplicate-${l.id}`} aria-label={`Duplicate ${l.name}`} onClick={() => onDuplicate(l.id)}>Duplicate</button>
              <button type="button" data-testid={`level-delete-${l.id}`} aria-label={`Delete ${l.name}`} onClick={() => onDelete(l.id)}>Delete</button>
            </span>
          </li>
        ))}
        {levels.length === 0 && <li className="muted">No levels yet.</li>}
      </ol>
      <form className="actions small" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        onAdd(String(f.get("name") ?? ""));
        e.currentTarget.reset();
      }}>
        <label>New level name <input name="name" type="text" maxLength={60} data-testid="level-new-name" autoComplete="off" /></label>
        <button type="submit" data-testid="level-add">Add level</button>
      </form>
    </div>
  );
}
