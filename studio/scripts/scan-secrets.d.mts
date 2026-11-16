export const RULES: { id: string; re: RegExp }[];
export function scan(dir: string): { scanned: number; findings: { file: string; rule: string; count: number }[] };
