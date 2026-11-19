export const EXCEPTION_PATH: string;
export const BASELINE_BLOB: string;
export const APPROVED_BLOB: string;
export const APPROVED_ADDED: number;
export const APPROVED_DELETED: number;
export const PASS_MESSAGE: string;
export interface EngineDiffInput { nameStatus: string; numstat: string; baselineBlob: string | null; currentBlob: string | null }
export function classifyEngineSchemaDiff(input: EngineDiffInput): { status: "PASS" | "FAIL"; summary: string };
