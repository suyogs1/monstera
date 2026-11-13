import { useSection } from "../../app/hooks";
import { goToPath } from "../../app/navigate";
import { getAt, type Path } from "../../draft/path";
import type { Json } from "../../schema/schema";
import { Card, Field, FieldGrid, useDoc } from "../fields";

const RT: Path = ["game", "runtime"];
const MAX_LIFE_SYMBOLS = 8;
const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9A-Fa-f]{6}$/.test(v);

/** Lives as the HUD writes them: one symbol per life (at most 8, then +n), or text when there is no symbol. */
function livesText(glyph: string, lives: number): string {
  if (glyph === "") return `lives ${lives}`;
  const symbols = glyph.repeat(Math.max(0, Math.min(lives, MAX_LIFE_SYMBOLS)));
  return lives > MAX_LIFE_SYMBOLS ? `${symbols} +${lives - MAX_LIFE_SYMBOLS}` : symbols;
}

function TextSample() {
  const doc = useDoc();
  if (doc === null) return null;
  const bg = getAt(doc, ["game", "palette", "background"]);
  const label = String(getAt(doc, ["game", "hud", "scoreLabel"]) ?? "");
  const glyph = String(getAt(doc, ["game", "hud", "lifeGlyph"]) ?? "");
  const lives = Number(getAt(doc, [...RT, "lives"]) ?? 0);
  return (
    <figure className="sample" style={{ background: isHex(bg) ? bg : undefined }}>
      <div className="sample-hud"><span>{label} 0</span><span>{livesText(glyph, lives)}</span></div>
      <div className="sample-card">
        <strong>{String(getAt(doc, ["project", "displayName"]) ?? "")}</strong>
        <span>{String(getAt(doc, ["game", "screens", "startHint"]) ?? "")}</span>
      </div>
      <figcaption>Wording sample only, not the game. Fonts, spacing and emoji artwork differ on each device.</figcaption>
    </figure>
  );
}

function LookGallery() {
  const doc = useDoc();
  const [, setSection] = useSection();
  const kinds = doc === null ? [] : ((getAt(doc, [...RT, "kinds"]) as Json[] | undefined) ?? []);
  if (!Array.isArray(kinds) || kinds.length === 0) return null;
  return (
    <Card title="How each kind looks">
      <ul className="gallery">
        {kinds.map((k, i) => {
          const color = getAt(k, ["color"]);
          return (
            <li key={i}>
              <button type="button" className="tile" onClick={() => goToPath([...RT, "kinds", i, "glyph"], setSection)}>
                <span className="swatch" style={{ background: isHex(color) ? color : "transparent" }} aria-hidden="true">{String(getAt(k, ["glyph"]) ?? "")}</span>
                <span className="mono small">{String(getAt(k, ["id"]) ?? "")}</span>
                <span className="muted small">{String(getAt(k, ["effect"]) ?? "")}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted small">Colour, symbol and vanish effect of each kind are edited with the kind, under Entities.</p>
    </Card>
  );
}

export function Presentation() {
  return (
    <section aria-labelledby="presentation-h">
      <header className="section-head">
        <h2 id="presentation-h">Presentation</h2>
        <p>
          Colours and texts. These are presentation only: the simulation never reads them, so changing them cannot change how
          the game plays.
        </p>
      </header>

      <Card title="Palette">
        <FieldGrid>
          <Field path={["game", "palette", "background"]} label="Background" />
          <Field path={["game", "palette", "primary"]} label="Primary" />
          <Field path={["game", "palette", "accent"]} label="Accent" />
        </FieldGrid>
        <p className="muted small">Primary and accent must stay readable on the background; the engine checks the contrast and reports it here.</p>
      </Card>

      <Card title="HUD">
        <FieldGrid>
          <Field path={["game", "hud", "scoreLabel"]} label="Score label" />
          <Field path={["game", "hud", "lifeGlyph"]} label="Life symbol" />
        </FieldGrid>
      </Card>

      <Card title="Start and end screens">
        <FieldGrid>
          <Field path={["game", "screens", "startHint"]} label="Start hint" wide />
          <Field path={["game", "screens", "winTitle"]} label="Win title" />
          <Field path={["game", "screens", "loseTitle"]} label="Lose title" />
        </FieldGrid>
      </Card>

      <TextSample />
      <LookGallery />
    </section>
  );
}
