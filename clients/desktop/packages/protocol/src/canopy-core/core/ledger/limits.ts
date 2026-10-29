export const LEDGER_LIMITS = {
  titleMaxCodePoints: 100,
  contentMaxCodePoints: 1_000,
  highlightsMax: 5,
  highlightMaxCodePoints: 100,
  referenceFilesMax: 25,
  pathMaxCodePoints: 1_024,
  opaqueIdMaxCodePoints: 512,
  settingMaxCodePoints: 256,
  requestMaxBytes: 131_072,
  requestKeyMaxLength: 128,
  searchQueryMaxCodePoints: 256,
  searchPageDefault: 30,
  searchPageMax: 100,
  searchEntryIdsMax: 25,
  ownersPageDefault: 30,
  ownersPageMax: 100,
  changesPageDefault: 100,
  changesPageMax: 500,
  historyPageDefault: 30,
  historyPageMax: 100,
  cursorMaxLength: 2_048,
  cursorLifetimeMs: 600_000,
  eligibilityTokenMaxLength: 512,
  displayNameMaxCodePoints: 256,
  evidenceEventIdsMax: 25,
  /**
   * Actor labels in one read result: every author, owner and mutation actor
   * an entry page or an entry with a history page can name.
   */
  actorLabelsMax: 512,
} as const;
