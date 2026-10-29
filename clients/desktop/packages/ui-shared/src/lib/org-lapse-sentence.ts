/**
 * "{Org} has no active plan" / "{A} and {B} have no active plan" — the shared
 * phrasing for a set of organizations that have lost the `teams` capability
 * (CAN-2311), i.e. `teamsEntitled: false`.
 *
 * Lives here rather than beside any one caller because several surfaces render
 * it (the composer's lapse banner, the Remote Control upgrade CTA, the
 * share-run refusal) and they must not drift: a user who sees two of them in
 * one session would otherwise read the same fact phrased two different ways.
 * Pure display, no data access, per the `@canopy/ui-shared` boundary.
 *
 * The wording is deliberately literal about what the data says (CAN-2590).
 * `teamsEntitled: false` means the organization's plan is not active, so it
 * grants its members nothing; it does NOT mean this user ever drew a capability
 * from that org. The renderer cannot tell the difference — the account snapshot
 * carries current capabilities plus per-org `teamsEntitled`, with no history and
 * no per-org plan detail — so this phrasing states a present-tense fact about
 * the org and never claims the lapse took something away or offers to restore
 * it. That caution is the reason "on hold" was replaced: it was undefined
 * jargon that read as a temporary suspension of the reader's own access.
 */
export function orgsWithoutActivePlanClause(names: readonly string[]): string {
  if (names.length === 0) {
    return '';
  }
  if (names.length === 1) {
    return `${names[0]} has no active plan`;
  }
  return `${formatOrgNameList(names)} have no active plan`;
}

/**
 * {@link orgsWithoutActivePlanClause} terminated as a standalone sentence, for
 * callers that open with it rather than embedding it.
 *
 * Two forms exist because the clause is a subordinate one on the Remote Control
 * paywall ("This feature requires Pro, and Acme has no active plan to cover
 * it.") and a full sentence in the composer's lapse banner. Baking the period
 * into the clause would split the paywall copy into two sentences; deriving the
 * sentence from the clause here keeps a single wording under both.
 *
 * Empty for no orgs — NOT a bare `'.'`, which is what an inline `${clause}.`
 * would render.
 */
export function orgsWithoutActivePlanSentence(
  names: readonly string[],
): string {
  const clause = orgsWithoutActivePlanClause(names);
  return clause ? `${clause}.` : '';
}

/**
 * "{A}" / "{A} and {B}" / "{A}, {B} and {C}" — the org-name list on its own, for
 * callers that supply their own surrounding sentence.
 *
 * Extracted from {@link orgsWithoutActivePlanClause} so other lapse copy stops
 * reaching for `names.join(', ')`, which reads correctly for one org and then
 * silently degrades: a bare join dropped into singular phrasing renders "Acme,
 * Initech does not have an active plan". Callers still own their own verb
 * agreement — see `names.length === 1` at each call site.
 */
export function formatOrgNameList(names: readonly string[]): string {
  if (names.length === 0) {
    return '';
  }
  if (names.length === 1) {
    return `${names[0]}`;
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
