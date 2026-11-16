// Types of the Studio sidecar manifests, version 1. The JSON Schemas in studio/schemas/ are the contract; these mirror them.
export interface Provenance {
  origin: "ai-generated" | "third-party-licensed" | "user-owned"; author: string; license: string; source: string;
  tool: string; model: string; promptSha256: string; acquiredOn: string; notes: string;
}
export interface Asset {
  id: string; kind: "audio" | "image"; category: "background" | "music" | "sfx" | "sprite" | "ui"; file: string; mime: string;
  bytes: number; sha256: string; width: number; height: number; durationMs: number; kindRefs: string[]; provenance: Provenance;
}
export interface Frame { id: string; x: number; y: number; w: number; h: number }
export interface Sheet {
  id: string; assetId: string;
  grid: { frameWidth: number; frameHeight: number; columns: number; rows: number; margin: number; spacing: number };
  frames: Frame[];
}
export interface Animation {
  id: string; sheetId: string; kindRef: string; fps: number; loop: "loop" | "once" | "pingpong";
  sequence: { frameId: string; holdFrames: number }[];
}
export interface Placement { id: string; kind: string; x: number; y: number; vx: number; vy: number; controlled: boolean }
export interface Wave {
  id: string; stream: string; kind: string; startTick: number; intervalTicks: number;
  xMin: number; xMax: number; yMin: number; yMax: number; vx: number; vy: number;
}
export interface DifficultyStep { id: string; waveId: string; stream: string; atTick: number; intervalTicks: number; vx: number; vy: number }
export interface Level { id: string; name: string; order: number; placements: Placement[]; waves: Wave[]; difficulty: DifficultyStep[] }
export interface ManifestEnvelope { schema: string; version: 1 }
export interface ProjectManifest extends ManifestEnvelope {
  projectId: string;
  spec: { path: "monstera.spec.json"; baseSha256: string; currentSha256: string };
  engine: { gitCommit: string };
  derivation: { levels: boolean; gameplay: boolean; activeLevel: string };
  derived: { inputsSha256: string };
  modules: string[];
}
export interface AssetsManifest extends ManifestEnvelope { nextSeq: number; assets: Asset[] }
export interface AnimationsManifest extends ManifestEnvelope { sheets: Sheet[]; animations: Animation[] }
export interface LevelsManifest extends ManifestEnvelope { levels: Level[] }
export interface GameplayManifest extends ManifestEnvelope {
  lives: { start: number }; score: { winScore: number };
  collectibles: { id: string; kind: string; collectorKind: string; points: number; despawn: boolean }[];
  enemies: { id: string; kind: string; targetKind: string; livesLost: number; despawnEnemy: boolean }[];
  planned: string[];
}
export interface AdPlacement { id: string; type: "banner" | "interstitial" | "rewarded"; trigger: string; minSecondsBetween: number; maxPerSession: number; rewardKind: string; rewardAmount: number }
export interface IntegrationsManifest extends ManifestEnvelope {
  backend: { provider: "firebase"; services: Record<string, boolean>; status: "scaffold"; configFiles: string[] };
  monetization: { provider: "admob"; mode: "mock" | "test"; placements: AdPlacement[] };
}
export interface ProposalManifest extends ManifestEnvelope {
  target: string; summary: string; ops: { op: "add" | "remove" | "set"; path: string; value: string }[];
}

