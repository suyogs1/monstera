// Every sentence the Backend and Monetization views show, as data, so the honesty test can scan all of it (design 8.2).
// Claim words (live, connected, production, store-ready) appear only in a sentence that negates them.
export const BACKEND_BANNER = "Scaffold only. Not connected to any backend.";
export const MONETIZATION_BANNER = "Mock only. The exported app shows a labelled MOCK overlay instead of an ad, no ad network is contacted, and there are no production ad ids.";
export const MOCK_LABEL = "MOCK";
export const BACKEND_TITLE = "Firebase services (scaffold)";
export const BACKEND_INTRO = "Choose which Firebase services the exported scaffold should include interfaces for. Studio creates no account, project or resource, and the scaffold holds no SDK, key or connection.";
export const SERVICES_TITLE = "Services";
export const CONFIG_TITLE = "Config files";
export const CONFIG_HELP = "You add these after export. They are git-ignored, and Studio never stores or reads them.";
export const SCAFFOLD_PREVIEW_TITLE = "Scaffold preview";
export const SCAFFOLD_PREVIEW_HELP = "Generated text only, read-only. It contacts no service and holds no key.";
export const PLACEMENTS_TITLE = "Ad placements (mock)";
export const PLACEMENTS_INTRO = "Placements describe when the mock ad service may simulate an ad. Nothing is shown to a player.";
export const MODE_LABEL = "Mode";
export const MODE_HELP = "mock simulates ads in the log. test marks the placements for the official Google test configuration that you add yourself after export.";
export const ID_HELP = "A placement name, not an ad unit id.";
export const REWARD_HELP = "Only a rewarded placement has a reward.";
export const MOCK_TITLE = "Mock behaviour";
export const MOCK_INTRO = "The exported MockRewardedAdService simulates an ad: it logs a line prefixed [MOCK AD], the app shows a labelled MOCK overlay instead of an ad, and your reward callback runs only for a rewarded placement.";
export const FREQUENCY_TITLE = "Frequency rules";
export const MOCK_PREVIEW_TITLE = "AdMob scaffold preview";
export const NOT_APPLIED = "Not applied: ";
export const DEVELOPER_NOTE = "Developers add their own ad unit ids in their own code after export. Studio has no field for them.";
export const ALL_LABELS: readonly string[] = [
  BACKEND_BANNER, MONETIZATION_BANNER, MOCK_LABEL, BACKEND_TITLE, BACKEND_INTRO, SERVICES_TITLE, CONFIG_TITLE, CONFIG_HELP, SCAFFOLD_PREVIEW_TITLE,
  SCAFFOLD_PREVIEW_HELP, PLACEMENTS_TITLE, PLACEMENTS_INTRO, MODE_LABEL, MODE_HELP, ID_HELP, REWARD_HELP, MOCK_TITLE, MOCK_INTRO, FREQUENCY_TITLE,
  MOCK_PREVIEW_TITLE, NOT_APPLIED, DEVELOPER_NOTE,
];
