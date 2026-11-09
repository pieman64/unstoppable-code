import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isWithin } from './relocation/transition';
import { internalRootSourceIsSeparate } from './internal-root-source';
import {
  InternalRootMigrationRefused,
  type InternalRootIdentity,
  type InternalRootInventory,
  type InternalRootExternalSnapshot,
  type InternalRootJournal,
} from './internal-root-migration';
import type { InternalRootRepairPlan } from './internal-root-repairs';
import type {
  RelocationAuthority,
  RelocationTransition,
  RelocationGitCheckout,
  RelocationBacklink,
  RelocationGitPlan,
  RelocationWorkspaceEvidence,
} from './relocation';
// Keep startup journal validation independent of the W5 execution graph: source
// consumers also load it through tsx's CommonJS loader beside native ESM.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
function isDigest(value: unknown): value is string {
  return isString(value) && /^[a-f0-9]{64}$/.test(value);
}
function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isArrayOf<T>(
  value: unknown,
  check: (entry: unknown) => entry is T,
): value is T[] {
  return Array.isArray(value) && value.every(check);
}
function isOptional<T>(
  value: unknown,
  check: (entry: unknown) => entry is T,
): value is T | undefined {
  return value === undefined || check(value);
}
function isIdentity(value: unknown): value is InternalRootIdentity {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'brandId',
      'brandDisplayName',
      'build',
      'source',
      'destination',
      'historicalSecure',
      'coordination',
    ]) &&
    (value.brandId === 'canopy' || value.brandId === 'unstoppable-code') &&
    value.build === 'internal' &&
    [
      'brandDisplayName',
      'source',
      'destination',
      'historicalSecure',
      'coordination',
    ].every((key) => isString(value[key]))
  );
}
function isInventory(value: unknown): value is InternalRootInventory {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'sourceIdentity',
      'destinationIdentity',
      'fingerprint',
      'files',
      'bytes',
      'historicalSecure',
      'nestedSecure',
      'stableOwned',
    ]) &&
    (value.sourceIdentity === null || isString(value.sourceIdentity)) &&
    (value.destinationIdentity === null ||
      isString(value.destinationIdentity)) &&
    isDigest(value.fingerprint) &&
    isNonnegativeInteger(value.files) &&
    isNonnegativeInteger(value.bytes) &&
    ['historicalSecure', 'nestedSecure', 'stableOwned'].every(
      (key) => typeof value[key] === 'boolean',
    )
  );
}
function isAuthority(value: unknown): value is RelocationAuthority {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['authorityId', 'canonicalDataRoot']) &&
    isDigest(value.authorityId) &&
    isString(value.canonicalDataRoot)
  );
}
function isTransition(value: unknown): value is RelocationTransition {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'version',
      'installationId',
      'brandId',
      'from',
      'to',
    ]) &&
    value.version === 1 &&
    isString(value.installationId) &&
    isString(value.brandId) &&
    isAuthority(value.from) &&
    isAuthority(value.to)
  );
}
function isCheckout(value: unknown): value is RelocationGitCheckout {
  const keys = ['path', 'commonDirectory', 'head', 'branch', 'status'];
  return (
    isRecord(value) &&
    hasOnlyKeys(value, keys) &&
    keys.every((key) => isString(value[key]))
  );
}
function isBacklink(value: unknown): value is RelocationBacklink {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['path', 'contents']) &&
    isString(value.path) &&
    isString(value.contents)
  );
}
function isGitPlan(value: unknown): value is RelocationGitPlan {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['checkouts', 'backlinks']) &&
    isArrayOf(value.checkouts, isCheckout) &&
    isArrayOf(value.backlinks, isBacklink)
  );
}
function isWorkspace(value: unknown): value is RelocationWorkspaceEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(
      value,
      ['workspaceId', 'targetId', 'manifestRaw', 'listRaw', 'repositoryPaths'],
      ['ownedPaths'],
    ) &&
    isString(value.workspaceId) &&
    isString(value.targetId) &&
    isString(value.manifestRaw) &&
    (value.listRaw === null || isString(value.listRaw)) &&
    isArrayOf(value.repositoryPaths, isString) &&
    (value.ownedPaths === undefined || isArrayOf(value.ownedPaths, isString))
  );
}
function isRepairPlan(value: unknown): value is InternalRootRepairPlan {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['transition', 'gitPlan', 'ownedPaths', 'workspaces']) &&
    isTransition(value.transition) &&
    isGitPlan(value.gitPlan) &&
    isArrayOf(value.ownedPaths, isString) &&
    isArrayOf(value.workspaces, isWorkspace)
  );
}
function isSnapshot(value: unknown): value is InternalRootExternalSnapshot {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['path', 'preimage', 'mode'], ['postimage']) &&
    isString(value.path) &&
    isDigest(value.preimage) &&
    isNonnegativeInteger(value.mode) &&
    value.mode <= 0o777 &&
    isOptional(value.postimage, isDigest)
  );
}
function isPhase(value: unknown): value is InternalRootJournal['phase'] {
  return (
    value === 'prepared' ||
    value === 'source-settled' ||
    value === 'building' ||
    value === 'publishing' ||
    value === 'rebuilding' ||
    value === 'restoring-external' ||
    value === 'complete'
  );
}
function isJournal(value: unknown): value is InternalRootJournal {
  return (
    isRecord(value) &&
    hasOnlyKeys(
      value,
      [
        'version',
        'transactionId',
        'identity',
        'internalDeclaration',
        'phase',
        'inventory',
        'externalFiles',
        'stagingRoot',
        'secureRelocation',
      ],
      [
        'stagingIdentity',
        'externalSnapshots',
        'publicationIdentity',
        'publicationFingerprint',
        'settledFingerprint',
        'repairPlan',
      ],
    ) &&
    (value.version === 6 || value.version === 7) &&
    isString(value.transactionId) &&
    /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(
      value.transactionId,
    ) &&
    isIdentity(value.identity) &&
    typeof value.internalDeclaration === 'boolean' &&
    isPhase(value.phase) &&
    isInventory(value.inventory) &&
    isArrayOf(value.externalFiles, isString) &&
    isString(value.stagingRoot) &&
    isOptional(value.stagingIdentity, isString) &&
    (value.externalSnapshots === undefined ||
      isArrayOf(value.externalSnapshots, isSnapshot)) &&
    isOptional(value.publicationIdentity, isString) &&
    isOptional(value.publicationFingerprint, isDigest) &&
    isOptional(value.settledFingerprint, isDigest) &&
    (value.secureRelocation === 'pending' ||
      value.secureRelocation === 'complete') &&
    isOptional(value.repairPlan, isRepairPlan)
  );
}

/** Single pure validator shared by synchronous admission and offline recovery. */
export function validateInternalRootJournal(
  raw: unknown,
  expectedIdentity: Omit<InternalRootIdentity, 'brandDisplayName'>,
  options: { readonly recordedSource?: boolean } = {},
): InternalRootJournal {
  try {
    if (!isJournal(raw)) throw new Error('Unrecognized journal shape');
    const journal = raw;
    // Startup consumes the recorded explicit source without probing it. Offline
    // resume still requires the operator's exact source selection to match.
    const identity = options.recordedSource
      ? { ...expectedIdentity, source: journal.identity.source }
      : expectedIdentity;
    if (
      !internalRootSourceIsSeparate(identity.source, [
        identity.destination,
        identity.coordination,
        `${identity.destination}.migration-staging`,
        identity.historicalSecure,
        join(
          dirname(identity.destination),
          `.${identity.brandId}-internal-startup.json`,
        ),
      ]) ||
      // Display copy comes from B's trusted manifest, not routing authority.
      [
        'brandId',
        'build',
        'source',
        'destination',
        'historicalSecure',
        'coordination',
      ].some(
        (key) =>
          Reflect.get(journal.identity, key) !== Reflect.get(identity, key),
      ) ||
      journal.stagingRoot !== `${identity.destination}.migration-staging` ||
      !journal.inventory.sourceIdentity ||
      (journal.version === 6 && journal.secureRelocation !== 'pending') ||
      (journal.secureRelocation === 'complete' &&
        journal.phase !== 'complete') ||
      journal.inventory.destinationIdentity !== null ||
      journal.inventory.stableOwned ||
      (identity.brandId === 'unstoppable-code' &&
        (!journal.internalDeclaration || journal.inventory.nestedSecure)) ||
      (journal.phase !== 'prepared' && !journal.settledFingerprint) ||
      (['publishing', 'complete', 'restoring-external', 'rebuilding'].includes(
        journal.phase,
      ) &&
        (!journal.publicationIdentity ||
          !journal.publicationFingerprint ||
          journal.stagingIdentity !== journal.publicationIdentity)) ||
      (journal.repairPlan !== undefined &&
        (journal.repairPlan.transition.installationId !==
          journal.transactionId ||
          journal.repairPlan.transition.brandId !== identity.brandId ||
          journal.repairPlan.transition.from.canonicalDataRoot !==
            identity.source ||
          journal.repairPlan.transition.to.canonicalDataRoot !==
            identity.destination)) ||
      journal.externalFiles.some(
        (path) =>
          !isAbsolute(path) ||
          resolve(path) !== path ||
          path.includes('\0') ||
          [
            identity.source,
            identity.destination,
            identity.coordination,
            `${identity.destination}.migration-staging`,
            identity.historicalSecure,
          ].some((root) => isWithin(root, path)),
      ) ||
      new Set(journal.externalFiles).size !== journal.externalFiles.length ||
      (journal.externalSnapshots !== undefined &&
        JSON.stringify(journal.externalSnapshots.map((entry) => entry.path)) !==
          JSON.stringify(journal.externalFiles)) ||
      ([
        'building',
        'publishing',
        'complete',
        'restoring-external',
        'rebuilding',
      ].includes(journal.phase) &&
        !journal.externalSnapshots) ||
      (['publishing', 'complete', 'restoring-external', 'rebuilding'].includes(
        journal.phase,
      ) &&
        journal.externalSnapshots?.some((entry) => !entry.postimage))
    )
      throw new Error('Unrecognized transaction');
    return journal;
  } catch {
    throw new InternalRootMigrationRefused(
      'journal-unsupported',
      'Unknown, older (including v4/v5), malformed or newer journal. Preserve both roots and request teammate-assisted recovery.',
    );
  }
}
