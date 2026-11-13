import { useSession } from "../../app/hooks";
import { ruleSentences } from "../../brain/summary";
import { addCollision, removeCollision } from "../../draft/ops";
import { getAt, toIssuePath, type Path } from "../../draft/path";
import { Card, Field, FieldGrid, KindSelect, useDoc } from "../fields";

const RT: Path = ["game", "runtime"];

export function Rules() {
  const { store } = useSession();
  const doc = useDoc();
  const rows = doc === null ? [] : (Array.isArray(getAt(doc, [...RT, "collisions"])) ? (getAt(doc, [...RT, "collisions"]) as unknown[]) : []);
  const sentences = doc === null ? [] : ruleSentences(doc);
  return (
    <section aria-labelledby="rules-h">
      <header className="section-head">
        <h2 id="rules-h">Rules &amp; scoring</h2>
        <p>
          Lives and the winning score, then every rule that fires when two kinds overlap. Effects are summed for each
          overlapping pair in a tick, so the order of rules does not matter.
        </p>
      </header>

      <Card title="Lives and winning">
        <FieldGrid>
          <Field path={[...RT, "lives"]} label="Starting lives" help="The game ends when lives reach 0." />
          <Field path={[...RT, "winScore"]} label="Winning score" />
        </FieldGrid>
      </Card>

      <h3 className="group">Collision rules ({rows.length})</h3>
      {rows.map((_, i) => {
        const base = [...RT, "collisions", i];
        return (
          <Card key={i} dataPath={toIssuePath(base)} title={sentences[i]?.text ?? `Rule ${i + 1}`}>
            <FieldGrid>
              <KindSelect path={[...base, "a"]} label="First kind" />
              <KindSelect path={[...base, "b"]} label="Second kind" />
              <Field path={[...base, "score"]} label="Score change" />
              <Field path={[...base, "lives"]} label="Lives change" />
              <Field path={[...base, "despawnA"]} label="First kind vanishes" />
              <Field path={[...base, "despawnB"]} label="Second kind vanishes" />
            </FieldGrid>
            <div className="row-actions">
              <button type="button" className="danger" onClick={() => doc !== null && store.replace(removeCollision(doc, i))}>Remove rule</button>
            </div>
          </Card>
        );
      })}
      <button type="button" className="primary" onClick={() => doc !== null && store.replace(addCollision(doc))}>Add rule</button>
    </section>
  );
}
