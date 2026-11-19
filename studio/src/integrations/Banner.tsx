import { BACKEND_BANNER, MONETIZATION_BANNER } from "./labels";
/** Permanent: no props that hide it, no state, no close control. */
export function ScaffoldBanner({ kind }: { kind: "backend" | "monetization" }) {
  return <p className="banner" role="note" data-testid="scaffold-banner" data-kind={kind}>{kind === "backend" ? BACKEND_BANNER : MONETIZATION_BANNER}</p>;
}
