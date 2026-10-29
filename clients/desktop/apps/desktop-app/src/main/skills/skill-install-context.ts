import type {
  InstallReceipt,
  ResourceContextInput,
} from '@canopy/desktop-shared/node';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { createHash } from 'node:crypto';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
} from '@canopy/desktop-shared/types/skills';
import { classifyResourceOwner } from '@canopy/desktop-shared/lib/resource-context';
import { createResourceInstallReceiptsStore } from '../lib/resource-install-receipts';
import { readCanopyCloudAccountWithStatus } from '../lib/canopy-cloud-account-store';
import { listCapabilityPackageInstalls } from '../pipelines/pipeline-package-install-store';
import { getPipelinePackageInstallStorePath } from '../lib/paths';
import {
  assertSkillContext,
  assertSkillContextSnapshot,
  skillContextSnapshot,
  skillResourceContextEnabled,
} from './resource-lanes';
import { getSharedSkill } from './canopy-server-client';
import { classifyInstalledResourceOrigin } from '../lib/resource-install-context';

export async function assertStoredSkillContext(
  localId: string,
  projectId?: string,
): Promise<void> {
  if (!skillResourceContextEnabled()) return;
  const account = await readCanopyCloudAccountWithStatus();
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  const binding = await createResourceInstallReceiptsStore(
    accountId ?? 'signed-out',
  ).findLocal('skills', localId);
  if (!binding) {
    await assertSkillContext(
      {
        owner: { type: 'user', id: 'local', name: null },
      },
      projectId,
    );
    return;
  }
  if (!accountId || binding.accountId !== accountId) {
    throw new Error('Skill unavailable (access-removed)');
  }
  // An install receipt is provenance, never a grant: reauthorize the remote id.
  const detail = await getSharedSkill(binding.receipt.remoteId);
  await assertSkillContext(
    {
      owner: detail.owner,
      provenance: binding.receipt,
    },
    projectId,
  );
}

/** Only aliases already bound to this account and source may be reused. */
export async function getSharedSkillInstallIds(
  remoteId: string,
): Promise<Set<string>> {
  if (!skillResourceContextEnabled()) return new Set();
  const account = await readCanopyCloudAccountWithStatus();
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  if (!accountId) throw new Error('Skill unavailable (access-removed)');
  const receipt = await createResourceInstallReceiptsStore(accountId).find(
    'skills',
    remoteId,
  );
  return new Set(receipt?.localResourceIds);
}

export async function recordSharedSkillInstall(
  detail: SharedSkillDetail,
  localId: string,
): Promise<(() => Promise<void>) | undefined> {
  if (!skillResourceContextEnabled()) return;
  await assertSkillContext({ owner: detail.owner });
  const account = await readCanopyCloudAccountWithStatus();
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  if (!accountId) throw new Error('Skill unavailable (access-removed)');
  const owner = classifyResourceOwner(detail.owner, { strict: true });
  if (owner === 'unknown')
    throw new Error('Skill unavailable (unknown-provenance)');
  const store = createResourceInstallReceiptsStore(accountId);
  const previous = await store.find('skills', detail.id);
  const receipt: InstallReceipt = {
    family: 'skills',
    remoteId: detail.id,
    localResourceIds: [localId],
    shareScope: detail.shareScope ?? 'private',
    ownerContext:
      typeof owner === 'object'
        ? { kind: 'organization', organizationId: owner.organizationId }
        : { kind: 'personal' },
    hash: createHash('sha256').update(detail.rawSkill).digest('hex'),
    authorizedAt: new Date().toISOString(),
  };
  await store.record(receipt);
  return (): Promise<void> => store.rollbackInstall(receipt, previous);
}

/**
 * Name the share each receipted local skill was installed from, and the
 * supporting-file package that completed for it, so a recipient surface reads
 * this account's receipts instead of guessing from content. A copy with no
 * receipt for a share is not that share's install: a scoped import never
 * reuses it. Read-only, and never fatal to the listing it annotates.
 */
export async function annotateSharedSkillInstalls(
  rows: InstalledSkillInfo[],
): Promise<InstalledSkillInfo[]> {
  if (!skillResourceContextEnabled()) return rows;
  try {
    const account = await readCanopyCloudAccountWithStatus();
    const accountId =
      account.status === 'ok' ? account.entry?.account?.id : undefined;
    if (!accountId) return rows;
    const receipts =
      await createResourceInstallReceiptsStore(accountId).listForAccount();
    // A local name freed by a deletion can be claimed by another share while
    // an older receipt still lists it; the latest authorization owns it.
    const bindings = new Map<string, { remoteId: string; at: number }>();
    for (const receipt of receipts) {
      if (receipt.family !== 'skills') continue;
      const at = Date.parse(receipt.authorizedAt);
      for (const localId of receipt.localResourceIds ?? []) {
        const current = bindings.get(localId);
        if (current === undefined || at > current.at)
          bindings.set(localId, { remoteId: receipt.remoteId, at });
      }
    }
    if (bindings.size === 0) return rows;
    const packages = await listCapabilityPackageInstalls(
      getPipelinePackageInstallStorePath(),
    );
    return rows.map((row) => {
      const remoteId = bindings.get(`${row.sourceId}/${row.name}`)?.remoteId;
      if (remoteId === undefined) return row;
      const installed = packages.find(
        (record) =>
          record.owner.kind === 'skill' &&
          record.owner.localId === row.name &&
          record.originExternalId === remoteId &&
          record.distributionMode !== 'definition_only',
      );
      return {
        ...row,
        installedFromShare: {
          remoteId,
          ...(installed?.packageDigest
            ? { packageDigest: installed.packageDigest }
            : {}),
        },
      };
    });
  } catch {
    // The origin is display metadata: an unreadable store leaves the listing
    // as it was, and the recipient surface falls back to offering Add.
    return rows;
  }
}

/**
 * Whether an install receipt binds this local skill to an owned remote source.
 * A receipted copy belongs to its receipt's context; a public install must not
 * adopt it even when the bytes are identical.
 */
export async function hasSkillInstallReceipt(
  localId: string,
): Promise<boolean> {
  if (!skillResourceContextEnabled()) return false;
  const account = await readCanopyCloudAccountWithStatus();
  if (account.status !== 'ok') return true;
  const accountId = account.entry?.account?.id;
  const binding = await createResourceInstallReceiptsStore(
    accountId ?? 'signed-out',
  ).findLocal('skills', localId);
  return binding !== undefined;
}

export async function copySkillInstallOrigin(
  source: string,
  destination: string,
): Promise<void> {
  if (!skillResourceContextEnabled()) return;
  await assertStoredSkillContext(source);
  const account = await readCanopyCloudAccountWithStatus();
  const id = account.status === 'ok' ? account.entry?.account?.id : undefined;
  if (!id) return;
  const store = createResourceInstallReceiptsStore(id);
  const binding = await store.findLocal('skills', source);
  if (binding)
    await store.record({ ...binding.receipt, localResourceIds: [destination] });
}

export async function filterStoredSkillContexts<
  T extends { sourceId: string; name: string },
>(rows: T[]): Promise<T[]> {
  if (!skillResourceContextEnabled()) return rows;
  const snapshot = await skillContextSnapshot();
  const allowed = await Promise.all(
    rows.map(async (row): Promise<boolean> => {
      try {
        await assertStoredSkillContext(`${row.sourceId}/${row.name}`);
        return true;
      } catch {
        return false;
      }
    }),
  );
  await assertSkillContextSnapshot(snapshot);
  return rows.filter((_row, index) => allowed[index]);
}

/** Context-independent Personal inventory used by desktop cloud sync. */
export async function filterPersonalStoredSkills<
  T extends { sourceId: string; name: string },
>(rows: T[]): Promise<T[]> {
  const origins = await Promise.all(
    rows.map((row) =>
      classifyInstalledResourceOrigin('skills', `${row.sourceId}/${row.name}`),
    ),
  );
  return rows.filter((_row, index) => origins[index] !== 'excluded');
}

/** An organization-origin copy must not be republished as a portable private copy. */
export async function assertSkillShareOrigin(
  localId: string,
  destinationOwner: unknown,
): Promise<void> {
  if (!skillResourceContextEnabled()) return;
  const account = await readCanopyCloudAccountWithStatus();
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  const binding = await createResourceInstallReceiptsStore(
    accountId ?? 'signed-out',
  ).findLocal('skills', localId);
  if (binding?.receipt.ownerContext.kind !== 'organization') return;
  const resource: ResourceContextInput['resource'] = {
    owner: { type: 'system' },
    provenance: binding.receipt,
  };
  const owner = classifyResourceOwner(destinationOwner, { strict: true });
  const { getResourceContextPolicyService } =
    await import('../services/resource-context-policy-service');
  const decision = await getResourceContextPolicyService().decide({
    resource,
    invocation: {
      mode: 'foreground',
      context: getWorkspaceContextService().getState().context,
    },
    target: {
      workspaceOwner:
        typeof owner === 'object'
          ? { kind: 'organization', organizationId: owner.organizationId }
          : { kind: 'personal' },
    },
  });
  if (!decision.allow)
    throw new Error(`Skill unavailable (${decision.reason})`);
}
