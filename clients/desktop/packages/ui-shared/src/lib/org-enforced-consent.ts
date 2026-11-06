// Pure presentation map turning generic org-enforced policies into OAuth-style
// consent items. Keeping the copy here (rather than in the DB or the wire
// contract) means the database only ever stores structured enforcement, and
// both the web invite surfaces and the desktop lock UI render identical wording.
//
// Adding a future enforced-policy kind means adding one `case` to
// `describeEnforcedPolicies` — every consent surface then renders it
// automatically.

import type {
  CanopyOrgEnforcedSettings,
  OrgEnforcedPolicyKind,
} from '@canopy/protocol';

/** One renderable OAuth-style consent bullet derived from an enforced policy. */
export interface OrgEnforcedConsentItem {
  policyKind: OrgEnforcedPolicyKind;
  /** Heading for the consent item, e.g. "Telemetry sync". */
  title: string;
  /** Sub-bullets describing the specifics, e.g. ["Transcripts", "Plans"]. */
  details: string[];
  /**
   * Whether this item describes data the org REQUIRES the member to share
   * (`'required'`) or data it PROHIBITS them from sharing anywhere
   * (`'blocked'`). A prospective member needs both: joining can turn sharing on
   * for them, and it can equally turn sharing OFF — including for their own
   * private cloud account and any other org they belong to.
   */
  disposition: 'required' | 'blocked';
}

/**
 * User-facing label for each telemetry-sync scope, in the canonical
 * least-invasive → most-invasive order shared with every other data-sharing
 * surface. Labels match `DATA_SHARING_SCOPE_LABELS` in `data-sharing-features`.
 */
const TELEMETRY_SCOPE_DETAIL_LABELS: {
  key: 'metadata' | 'plans' | 'summaries' | 'transcripts';
  label: string;
}[] = [
  { key: 'metadata', label: 'Usage metadata' },
  { key: 'plans', label: 'Plans' },
  { key: 'summaries', label: 'Session summaries' },
  { key: 'transcripts', label: 'Transcripts' },
];

type TelemetryScopeFlags = Record<
  (typeof TELEMETRY_SCOPE_DETAIL_LABELS)[number]['key'],
  boolean
>;

function noScopes(): TelemetryScopeFlags {
  return {
    metadata: false,
    plans: false,
    summaries: false,
    transcripts: false,
  };
}

/**
 * Turn the generic, per-org enforced policies into a flat, de-duplicated list of
 * consent items. Scopes are unioned across every org, so a member belonging to
 * multiple enforcing orgs sees one combined item per disposition. Policies that
 * enforce nothing produce no item.
 *
 * Returns up to three items: what joining REQUIRES the member to share, which
 * AI gateway their agent traffic is routed through, and what joining BLOCKS
 * them from sharing. The blocked item is not cosmetic — a prohibition is
 * global, so it also silences that scope for the member's own private cloud
 * account and for every other org they belong to. Telling them only what gets
 * turned on would be a materially incomplete consent screen.
 *
 * Every flag is read with a strict `=== true`. Under the three-state model an
 * absent/`undefined` scope means "unset" (the member's own choice), so a
 * negated test here would invent a policy the org never set.
 */
export function describeEnforcedPolicies(
  settings: CanopyOrgEnforcedSettings[] | null | undefined,
): OrgEnforcedConsentItem[] {
  if (!settings || settings.length === 0) {
    return [];
  }

  // Union telemetry-sync scopes across all orgs, keeping requirements and
  // prohibitions apart so each renders under its own heading.
  const required = noScopes();
  const prohibited = noScopes();

  // Gateway endpoints the member's agent traffic would be routed to, in first-
  // seen order and de-duplicated: two orgs can name the same gateway, and a
  // consent screen that lists one endpoint twice reads like two boundaries.
  const gatewayBaseUrls: string[] = [];
  let gatewayIsExclusive = false;

  for (const org of settings) {
    for (const policy of org.policies) {
      switch (policy.kind) {
        case 'telemetry-sync':
          for (const scope of TELEMETRY_SCOPE_DETAIL_LABELS) {
            if (policy.scopes[scope.key] === true) {
              required[scope.key] = true;
            }
            if (policy.prohibitedScopes?.[scope.key] === true) {
              prohibited[scope.key] = true;
            }
          }
          break;
        case 'model-policy':
          // Model availability is enforced at selection/execution boundaries,
          // not represented in the telemetry-consent summary.
          break;
        case 'model-gateway': {
          // The endpoint itself is the consent: joining sends this member's
          // prompts and code to a server the org runs, under the org's
          // contract, so naming it is the whole point of the bullet. An
          // enforced gateway additionally turns off every other route, which
          // is a separate fact and gets its own line.
          if (policy.enforced === true) {
            // Match routing precedence: the first enforcing organization wins
            // over additive declarations and any later enforcing org.
            if (!gatewayIsExclusive) {
              gatewayBaseUrls.length = 0;
              const baseUrl = policy.baseUrl.trim();
              if (baseUrl.length > 0) gatewayBaseUrls.push(baseUrl);
              gatewayIsExclusive = true;
            }
          } else if (!gatewayIsExclusive) {
            const baseUrl = policy.baseUrl.trim();
            if (baseUrl.length > 0 && !gatewayBaseUrls.includes(baseUrl)) {
              gatewayBaseUrls.push(baseUrl);
            }
          }
          break;
        }
        default: {
          // Exhaustiveness guard: a new policy kind must add a case above.
          // At runtime, tolerate unknown kinds (e.g. forward-compat JSON) by
          // ignoring them rather than returning a non-array value.
          const _exhaustive: never = policy;
          void _exhaustive;
          break;
        }
      }
    }
  }

  // Prohibition beats requirement during resolution, so mirror that here rather
  // than listing a scope under both headings and contradicting ourselves.
  for (const scope of TELEMETRY_SCOPE_DETAIL_LABELS) {
    if (prohibited[scope.key]) {
      required[scope.key] = false;
    }
  }

  const items: OrgEnforcedConsentItem[] = [];

  const requiredDetails = TELEMETRY_SCOPE_DETAIL_LABELS.filter(
    (scope) => required[scope.key],
  ).map((scope) => scope.label);
  if (requiredDetails.length > 0) {
    items.push({
      policyKind: 'telemetry-sync',
      title: 'Telemetry sync',
      details: requiredDetails,
      disposition: 'required',
    });
  }

  if (gatewayBaseUrls.length > 0) {
    items.push({
      policyKind: 'model-gateway',
      title: 'AI gateway',
      details: [
        ...gatewayBaseUrls,
        gatewayIsExclusive
          ? 'Your agents run only through this gateway.'
          : 'You can still use your other models alongside it.',
      ],
      disposition: 'required',
    });
  }

  const blockedDetails = TELEMETRY_SCOPE_DETAIL_LABELS.filter(
    (scope) => prohibited[scope.key],
  ).map((scope) => scope.label);
  if (blockedDetails.length > 0) {
    items.push({
      policyKind: 'telemetry-sync',
      title: 'Blocked from sharing',
      details: blockedDetails,
      disposition: 'blocked',
    });
  }

  return items;
}
