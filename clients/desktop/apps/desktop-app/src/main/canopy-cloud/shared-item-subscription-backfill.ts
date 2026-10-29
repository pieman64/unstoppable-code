/**
 * Local provenance for shared-item install subscriptions.
 *
 * {@link collectSharedItemInstallsForBackfill} lists the shared items this
 * device installed before install subscriptions existed, so the subscription
 * ledger can register them once per account. Uninstall call sites that cannot
 * name a removed copy's share look it up in the ledger by local id instead.
 *
 * Every source reads only local state. A stored content hash is sent when the
 * install recorded one; otherwise the hash is `null` and the server records
 * the live hash.
 *
 * Known gap: a Public skill installed before this release left no install
 * record this collector can trust, so it cannot be backfilled. (The skill
 * share-origin pin in the capability package store is ambiguous between team
 * and Public shares and outlives the skill.)
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { SharedItemKind } from '@canopy/protocol/shared-item-subscriptions';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { SharedItemInstallRecord } from './shared-item-subscriptions';
import { getFeatureFlagService } from '../feature-flags';
import { readCanopyCloudAccountWithStatus } from '../lib/canopy-cloud-account-store';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { createResourceInstallReceiptsStore } from '../lib/resource-install-receipts';
import { CUSTOM_SOURCE_ID, getSkillDir } from '../skills/paths';

const LOG_PREFIX = '[shared-item-subscriptions]';
const CURATED_ORIGIN_PREFIX = 'curated:';

/** Receipt families that are installed straight from a team or organization share. */
type ReceiptedSharedInstallFamily = 'skills' | 'pipelines';

async function readCurrentAccountId(): Promise<string | undefined> {
  const account = await readCanopyCloudAccountWithStatus();
  return account.status === 'ok' ? account.entry?.account?.id : undefined;
}

/**
 * Local id to remote id for the signed-in account's team and organization
 * install receipts. A local name freed by a deletion can be claimed by another
 * share while an older receipt still lists it; the latest authorization owns it.
 */
async function readReceiptedLocalOrigins(
  family: ReceiptedSharedInstallFamily,
): Promise<Map<string, string>> {
  const accountId = await readCurrentAccountId();
  if (!accountId) return new Map();
  const receipts =
    await createResourceInstallReceiptsStore(accountId).listForAccount();
  const latest = new Map<string, { remoteId: string; at: number }>();
  for (const receipt of receipts) {
    if (receipt.family !== family || receipt.sourceKind === 'public-share')
      continue;
    const at = Date.parse(receipt.authorizedAt);
    for (const localId of receipt.localResourceIds ?? []) {
      const current = latest.get(localId);
      if (current === undefined || at > current.at)
        latest.set(localId, { remoteId: receipt.remoteId, at });
    }
  }
  return new Map(
    Array.from(latest, ([localId, origin]) => [localId, origin.remoteId]),
  );
}

/**
 * Whether team and organization receipts apply. Throws while flags are still
 * loading, so a startup backfill counts that source as failed and retries it
 * instead of settling on the not-yet-loaded value.
 */
function orgProjectsEnabled(): boolean {
  const service = getFeatureFlagService();
  if (service.getSnapshot().status === 'initializing')
    throw new Error('Feature flags are still loading.');
  return service.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key);
}

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

async function collectAutomations(): Promise<SharedItemInstallRecord[]> {
  const { getAutomationsService } = await import('../automations/service');
  const activities =
    await getAutomationsService().listInstalledActivitiesForSubscriptionBackfill();
  const records: SharedItemInstallRecord[] = [];
  for (const activity of activities) {
    const installedFrom = activity.installedFrom;
    if (!installedFrom || installedFrom.sourceKind === 'curated') continue;
    records.push({
      kind: 'automation',
      remoteId: installedFrom.remoteId,
      sourceKind: installedFrom.sourceKind === 'public' ? 'public' : 'shared',
      contentHash: nonEmpty(installedFrom.contentHash),
      localId: activity.id,
    });
  }
  return records;
}

async function collectCollections(): Promise<SharedItemInstallRecord[]> {
  const { listCollectionSharedSourcesForBackfill } =
    await import('../collections/collection-store');
  return (await listCollectionSharedSourcesForBackfill()).map(
    ({ id, sharedSource }) => ({
      kind: 'collection',
      remoteId: sharedSource.remoteId,
      sourceKind: sharedSource.fromPublicShare === true ? 'public' : 'shared',
      contentHash: nonEmpty(sharedSource.contentHash),
      localId: id,
    }),
  );
}

async function collectAgents(): Promise<SharedItemInstallRecord[]> {
  const { listAgentModelsForInstallBackfill } =
    await import('../agents/agent-model-store');
  const records: SharedItemInstallRecord[] = [];
  for (const agent of await listAgentModelsForInstallBackfill()) {
    // `remoteId` alone is the author's own share link, not an install.
    if (agent.importedFromRemoteId !== undefined)
      records.push({
        kind: 'agent',
        remoteId: agent.importedFromRemoteId,
        sourceKind: 'shared',
        contentHash: nonEmpty(agent.remoteContentHash),
        localId: agent.id,
      });
    if (agent.publicShareExternalId !== undefined)
      records.push({
        kind: 'agent',
        remoteId: agent.publicShareExternalId,
        sourceKind: 'public',
        contentHash: nonEmpty(agent.publicShareContentHash),
        localId: agent.id,
      });
  }
  return records;
}

async function collectPublicPipelines(): Promise<SharedItemInstallRecord[]> {
  const { listPackageInstalls } =
    await import('../pipelines/pipeline-package-service');
  const records: SharedItemInstallRecord[] = [];
  for (const install of await listPackageInstalls()) {
    const origin = install.originExternalId;
    // No origin is a team package install (receipted); curated is not shared.
    if (origin === undefined || origin.startsWith(CURATED_ORIGIN_PREFIX))
      continue;
    records.push({
      kind: 'pipeline',
      remoteId: origin,
      sourceKind: 'public',
      contentHash: nonEmpty(install.pipelineContentHash),
      localId: install.localPipelineId,
    });
  }
  return records;
}

async function collectProjectTemplates(): Promise<SharedItemInstallRecord[]> {
  const { listCoworkTemplateInstallsForBackfill } =
    await import('../lib/cowork-workspace-crud');
  return (await listCoworkTemplateInstallsForBackfill()).map((install) => ({
    kind: 'workspace-template',
    remoteId: install.externalId,
    // The server addresses templates by their share id and ignores the kind.
    sourceKind: 'shared',
    contentHash: install.contentHash,
    localId: install.workspaceId,
  }));
}

async function customSkillExists(localId: string): Promise<boolean> {
  const prefix = `${CUSTOM_SOURCE_ID}/`;
  if (!localId.startsWith(prefix)) return false;
  const name = localId.slice(prefix.length);
  if (!name || name.includes('/') || name.includes('\\') || name === '..')
    return false;
  try {
    await access(join(getSkillDir(CUSTOM_SOURCE_ID, name), 'SKILL.md'));
    return true;
  } catch {
    return false;
  }
}

async function collectReceiptedInstalls(
  family: ReceiptedSharedInstallFamily,
  kind: Extract<SharedItemKind, 'skill' | 'pipeline'>,
  exists: (localId: string) => Promise<boolean>,
): Promise<SharedItemInstallRecord[]> {
  if (!orgProjectsEnabled()) return [];
  const records: SharedItemInstallRecord[] = [];
  // Receipts outlive their local copies, so only copies still present count.
  const origins = Array.from(await readReceiptedLocalOrigins(family));
  for (const [localId, remoteId] of origins) {
    if (!(await exists(localId))) continue;
    // Receipts carry a local hash, not the server's content hash.
    records.push({
      kind,
      remoteId,
      sourceKind: 'shared',
      contentHash: null,
      localId,
    });
  }
  return records;
}

async function collectTeamSkills(): Promise<SharedItemInstallRecord[]> {
  return collectReceiptedInstalls('skills', 'skill', customSkillExists);
}

async function collectTeamPipelines(): Promise<SharedItemInstallRecord[]> {
  if (!orgProjectsEnabled()) return [];
  const { listPipelines } = await import('../pipelines/pipeline-service');
  const listed = listPipelines();
  const ids = new Set(
    listed.success ? (listed.data ?? []).map((row) => row.id) : [],
  );
  return collectReceiptedInstalls('pipelines', 'pipeline', (localId) =>
    Promise.resolve(ids.has(localId)),
  );
}

const SOURCES: ReadonlyArray<{
  name: string;
  collect: () => Promise<SharedItemInstallRecord[]>;
}> = [
  { name: 'automations', collect: collectAutomations },
  { name: 'collections', collect: collectCollections },
  { name: 'agents', collect: collectAgents },
  { name: 'public pipelines', collect: collectPublicPipelines },
  { name: 'project templates', collect: collectProjectTemplates },
  { name: 'team skills', collect: collectTeamSkills },
  { name: 'team pipelines', collect: collectTeamPipelines },
];

export interface SharedItemInstallBackfill {
  records: SharedItemInstallRecord[];
  /** `false` when a source failed, so the backfill must run again later. */
  complete: boolean;
}

/**
 * Every shared item installed on this device that local state can attribute
 * to a share. Each source is read independently: one that fails is logged and
 * skipped so the rest still register, and the result reports incomplete.
 */
export async function collectSharedItemInstallsForBackfill(): Promise<SharedItemInstallBackfill> {
  const records: SharedItemInstallRecord[] = [];
  let complete = true;
  for (const source of SOURCES) {
    try {
      records.push(...(await source.collect()));
    } catch (error) {
      complete = false;
      logMainProcessWarn(
        `${LOG_PREFIX} Skipped a backfill source that could not be read.`,
        {
          source: source.name,
          reason: error instanceof Error ? error.name : typeof error,
        },
      );
    }
  }
  return { records, complete };
}
