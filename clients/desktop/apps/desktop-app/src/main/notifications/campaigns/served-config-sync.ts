import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  parseServedCampaignConfig,
  type ServedCampaignConfig,
} from '@canopy/protocol/notification-campaigns';
import { getServedCampaignConfigFilePath } from '../../lib/paths';
import type { ActivationCampaignId } from '@canopy/desktop-shared/types';
import {
  ACTIVATION_CAMPAIGNS,
  type CampaignDefinition,
  type CampaignVariant,
} from './campaign-config';
import { mapServedCampaigns } from './served-config-mapper';

/**
 * Hub-served campaign config (CAN-2765).
 *
 * The compiled `ACTIVATION_CAMPAIGNS` table is the floor, not the default: it
 * is what runs when nothing valid has ever been served. Once a document has
 * been fetched and cached, that cached document is used on subsequent
 * launches even offline — a copy change that shipped weeks ago should not
 * undo itself the first time a laptop opens on a plane.
 *
 * Every path into `activeCampaigns` goes through the protocol parser and then
 * the mapper, and both are all-or-nothing. There is no state in which a
 * partially-applied document is scheduling notifications.
 */

let activeCampaigns: readonly CampaignDefinition[] | null = null;

/**
 * Campaigns the scheduler should run. Falls back to the compiled table until
 * a served document has been successfully applied.
 */
export function getActiveCampaigns(): readonly CampaignDefinition[] {
  return activeCampaigns ?? ACTIVATION_CAMPAIGNS;
}

function applyDocument(raw: unknown): ServedCampaignConfig | null {
  const parsed = parseServedCampaignConfig(raw);
  if (parsed === null) return null;
  const mapped = mapServedCampaigns(parsed);
  if (mapped === null) return null;
  activeCampaigns = mapped;
  return parsed;
}

/**
 * Apply the cached document, if one is readable and still valid for this
 * build. Invalid cache is ignored rather than deleted: a client rolled back
 * to an older build may not understand a document a newer build cached, and
 * deleting it would lose config the newer build can still use.
 */
export async function loadCachedServedCampaigns(): Promise<boolean> {
  try {
    const raw = await readFile(getServedCampaignConfigFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return applyDocument(parsed) !== null;
  } catch {
    return false;
  }
}

export type ServedCampaignFetcher = () => Promise<unknown>;

/**
 * Fetch, validate, apply, and cache. Returns whether the served document was
 * applied; on any failure the previously active campaigns are left untouched,
 * so a bad deploy or an offline launch degrades to the last good state rather
 * than to nothing.
 */
export async function refreshServedCampaigns(
  fetcher: ServedCampaignFetcher,
): Promise<boolean> {
  let raw: unknown;
  try {
    raw = await fetcher();
  } catch {
    return false;
  }
  const parsed = applyDocument(raw);
  if (parsed === null) return false;

  // Cache the PARSED document, not the raw response: the raw body can carry
  // unbounded extra keys that still parse, and writing them would put
  // unvalidated bytes on disk under the guise of validated config.
  const filePath = getServedCampaignConfigFilePath();
  // randomUUID as well as pid, matching `lib/github-refresh-ledger.ts`: pid
  // alone collides after wraparound, and a quit mid-write orphans the file.
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } catch {
    await unlink(tempPath).catch(() => undefined);
    // The document is applied for this session even if caching failed; the
    // next launch simply re-fetches.
  }
  return true;
}

/**
 * Campaign lookups resolve against the ACTIVE table, not the compiled one.
 *
 * They live here rather than beside the compiled definitions because "which
 * campaign is this id" is a question about current config, and answering it
 * from the compiled table would make a click on a served campaign route to
 * the destination that shipped in the binary.
 */
export function getCampaignDefinition(
  id: ActivationCampaignId,
): CampaignDefinition | undefined {
  return getActiveCampaigns().find((campaign) => campaign.id === id);
}

export function getCampaignVariant(
  id: ActivationCampaignId,
  variantKey: string,
): CampaignVariant | undefined {
  return getCampaignDefinition(id)?.variants[variantKey];
}

/** Test-only: drop the applied document so the compiled table is used again. */
export function resetServedCampaignsForTests(): void {
  activeCampaigns = null;
}
