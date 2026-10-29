import {
  ACTIVATION_CAMPAIGN_IDS,
  type ActivationCampaignId,
  type CampaignDestination,
  type NavigationPage,
  type SettingsSection,
} from '@canopy/desktop-shared/types';
import {
  CAMPAIGN_COPY_TOKENS,
  SERVED_CAMPAIGN_PAGES,
  SERVED_CAMPAIGN_SETTINGS_SECTIONS,
  type ServedCampaign,
  type ServedCampaignConfig,
  type ServedCampaignDestination,
} from '@canopy/protocol/notification-campaigns';
import { BRAND } from '@canopy/brand/current';
import type { CampaignDefinition, CampaignVariant } from './campaign-config';

/**
 * Maps a validated served document onto the desktop campaign shape.
 *
 * The protocol parser proves the payload is well-formed; this proves it is
 * *reachable and permitted on this build*. Those are different questions, and
 * doing them in one place would put renderer navigation vocabulary into a
 * package that must not know about it.
 */

/**
 * The allowlists now live in `@canopy/protocol/notification-campaigns` so the
 * SERVER rejects the same documents this build would -- publish previously
 * accepted a destination desktop refuses, which then reverted every campaign
 * for the brand to compiled with no signal. What stays here is the narrowing
 * from protocol's plain string literals to the renderer's own unions, which
 * is the part protocol must not know about.
 */
/**
 * Constructed as `Set<NavigationPage>` / `Set<SettingsSection>` specifically so
 * the compiler proves every protocol value is a real renderer destination. A
 * bare `includes` on `readonly string[]` would only *assert* it, and protocol
 * cannot import these unions to check itself — so this is where a typo in the
 * served allowlist gets caught, at build time rather than as a campaign that
 * silently never routes.
 */
// Annotated `ReadonlySet<string>` so `.has(value)` needs no cast, while the
// CONSTRUCTOR stays `new Set<NavigationPage>(...)` -- that argument check is
// where the proof lives, so a bad protocol value still fails the build here.
const ALLOWED_PAGES: ReadonlySet<string> = new Set<NavigationPage>(
  SERVED_CAMPAIGN_PAGES,
);

const ALLOWED_SETTINGS_SECTIONS: ReadonlySet<string> = new Set<SettingsSection>(
  SERVED_CAMPAIGN_SETTINGS_SECTIONS,
);

function isAllowedPage(value: string): value is NavigationPage {
  return ALLOWED_PAGES.has(value);
}

function isAllowedSection(value: string): value is SettingsSection {
  return ALLOWED_SETTINGS_SECTIONS.has(value);
}

function mapDestination(
  destination: ServedCampaignDestination,
): CampaignDestination | null {
  switch (destination.kind) {
    case 'page':
      return isAllowedPage(destination.page)
        ? { kind: 'page', page: destination.page }
        : null;
    case 'settings':
      return isAllowedSection(destination.section)
        ? { kind: 'settings', section: destination.section }
        : null;
    case 'canopy-portal':
      return { kind: 'canopy-portal' };
    case 'add-workspace':
      return { kind: 'add-workspace' };
  }
}

/**
 * Substitute brand tokens in served copy. Hub-authored strings must not carry
 * product names: user-visible names come from the brand runtime, and a served
 * literal would bypass the branding rules entirely and ship the wrong product
 * name on a white-labelled build.
 */
const TOKEN_VALUES: Readonly<Record<string, () => string>> = {
  '{appName}': () => BRAND.displayName,
};

export function renderCampaignCopy(text: string): string {
  let rendered = text;
  for (const token of CAMPAIGN_COPY_TOKENS) {
    const resolve = TOKEN_VALUES[token];
    if (resolve === undefined) continue;
    rendered = rendered.split(token).join(resolve());
  }
  return rendered;
}

function isKnownCampaignId(value: string): value is ActivationCampaignId {
  return (ACTIVATION_CAMPAIGN_IDS as readonly string[]).includes(value);
}

function mapCampaign(served: ServedCampaign): CampaignDefinition | null {
  // The hub reconfigures campaigns this build knows about; it cannot invent
  // new ones. Eligibility predicates, the send-once latch, and telemetry are
  // all keyed by `ActivationCampaignId`, so an unknown id would be a campaign
  // with no gating -- and a genuinely new campaign needs new predicate code,
  // which is a desktop release regardless.
  if (!isKnownCampaignId(served.id)) return null;

  // `fromEntries` rather than key-by-key assignment, mirroring the parser: a
  // `__proto__` key would otherwise hit the prototype setter. Unreachable
  // today because parse always precedes map, but the invariant should not
  // depend on call order.
  const entries: [string, CampaignVariant][] = [];
  for (const [key, variant] of Object.entries(served.variants)) {
    const destination = mapDestination(variant.destination);
    if (destination === null) return null;
    entries.push([
      key,
      {
        title: renderCampaignCopy(variant.title),
        body: renderCampaignCopy(variant.body),
        destination,
      },
    ]);
  }
  const variants: Record<string, CampaignVariant> = Object.fromEntries(entries);
  return {
    id: served.id,
    anchor: served.anchor,
    offsetMs: served.offsetMs,
    maxLatenessMs: served.maxLatenessMs,
    variants,
  };
}

/**
 * Returns `null` if any campaign is unmappable — an unknown id, an
 * unreachable destination, or a settings pane campaigns may not target.
 *
 * Same all-or-nothing rule the parser uses: a document that is only
 * half-reachable on this build would schedule a subset no author reviewed,
 * and the compiled table is a coherent alternative where a partial document
 * is not.
 *
 * This is also what makes a rollback safe. An older client that does not know
 * a newly-added campaign id rejects the whole document and keeps its compiled
 * table, rather than silently running a partial journey.
 */
export function mapServedCampaigns(
  config: ServedCampaignConfig,
): CampaignDefinition[] | null {
  const mapped: CampaignDefinition[] = [];
  for (const served of config.campaigns) {
    const campaign = mapCampaign(served);
    if (campaign === null) return null;
    mapped.push(campaign);
  }
  return mapped;
}
