// Line diff of two canonical spec texts, for the Spec view. Presentation only.
export type DiffLine = { kind: "same" | "add" | "del"; text: string; oldNo?: number; newNo?: number };

export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split("\n"), y = b.split("\n");
  // Trim the common prefix and suffix first; canonical specs differ in a few lines, so the DP stays tiny.
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length, endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) { endX--; endY--; }
  const mid = (xs: string[], ys: string[]): DiffLine[] => {
    const n = xs.length, m = ys.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = xs[i] === ys[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
    const out: DiffLine[] = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (xs[i] === ys[j]) { out.push({ kind: "same", text: xs[i]! }); i++; j++; }
      else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: "del", text: xs[i++]! });
      else out.push({ kind: "add", text: ys[j++]! });
    }
    while (i < n) out.push({ kind: "del", text: xs[i++]! });
    while (j < m) out.push({ kind: "add", text: ys[j++]! });
    return out;
  };
  const all: DiffLine[] = [
    ...x.slice(0, start).map((text) => ({ kind: "same" as const, text })),
    ...mid(x.slice(start, endX), y.slice(start, endY)),
    ...x.slice(endX).map((text) => ({ kind: "same" as const, text })),
  ];
  let o = 0, n = 0;
  return all.map((l) => {
    if (l.kind !== "add") o++;
    if (l.kind !== "del") n++;
    return { ...l, ...(l.kind !== "add" ? { oldNo: o } : {}), ...(l.kind !== "del" ? { newNo: n } : {}) };
  });
}

/** Changed lines with `context` unchanged lines around them; gaps become a single "skip" marker. */
export function hunks(lines: DiffLine[], context = 2): (DiffLine | { kind: "skip"; count: number })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | { kind: "skip"; count: number })[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) { out.push({ kind: "skip", count: skipped }); skipped = 0; }
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ kind: "skip", count: skipped });
  return out;
}
