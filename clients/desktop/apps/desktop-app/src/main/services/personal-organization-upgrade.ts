import { createHash } from 'node:crypto';
import type { CanopyCloudCredentialContext } from '../canopy-cloud/client';
import type { PersonalOrganizationUpgradeJournal } from '../lib/personal-organization-upgrade-journal';
import type { OrgMemberCreationOptions } from '../lib/org-member-code-create';
import type {
  CreateOrgMemberCodeProjectResult,
  CreateOrgMemberMultiRepoProjectResult,
} from '@canopy/desktop-shared/types';
import {
  PersonalProjectConversionRequestSchema,
  type PersonalProject,
  type PersonalProjectOperation,
  type PersonalProjectConversionRequest,
  type PersonalOrganizationPromotionOutcome,
  type UpgradePersonalOrganizationRequest,
  type UpgradePersonalOrganizationResult,
  type SendOrganizationInviteRequest,
  type OrganizationInviteResult,
  type OrganizationInviteStatus,
} from '@canopy/protocol/organizations';

export interface UpgradeWorkspace extends PersonalProject {
  path: string;
  owner?: { organizationId: string; projectId: string };
}
export interface UpgradeIdentity {
  accountId: string;
  epoch: number;
  credentials: CanopyCloudCredentialContext;
}
export interface PersonalOrganizationUpgradeDeps {
  identity(this: void): Promise<UpgradeIdentity>;
  sessionCurrent(this: void, sessionId: string): boolean;
  destination(
    this: void,
    organizationId: string,
    identity: UpgradeIdentity,
  ): Promise<boolean>;
  workspaces(this: void): Promise<UpgradeWorkspace[]>;
  promote(
    this: void,
    request: UpgradePersonalOrganizationRequest,
    identity: UpgradeIdentity,
  ): Promise<UpgradePersonalOrganizationResult>;
  suppress(this: void, organizationId: string): Promise<void>;
  refreshAccount(
    this: void,
    identity: UpgradeIdentity,
  ): Promise<UpgradeIdentity>;
  switchContext(this: void, organizationId: string): Promise<void>;
  invite(
    this: void,
    organizationId: string,
    request: SendOrganizationInviteRequest,
    identity: UpgradeIdentity,
  ): Promise<OrganizationInviteResult>;
  inviteStatus(
    this: void,
    organizationId: string,
    email: string,
    identity: UpgradeIdentity,
  ): Promise<OrganizationInviteStatus>;
  createSingle(
    this: void,
    workspace: UpgradeWorkspace,
    organizationId: string,
    creationKey: string,
    projectId: string | undefined,
    options: OrgMemberCreationOptions,
  ): Promise<CreateOrgMemberCodeProjectResult>;
  createMulti(
    this: void,
    workspace: UpgradeWorkspace,
    organizationId: string,
    options: OrgMemberCreationOptions,
  ): Promise<CreateOrgMemberMultiRepoProjectResult>;
  share(
    this: void,
    organizationId: string,
    projectId: string,
    identity: UpgradeIdentity,
  ): Promise<void>;
  refreshCatalog(this: void, organizationId: string): Promise<void>;
  journal: PersonalOrganizationUpgradeJournal;
  now(this: void): string;
}

/** One mutation lane serializes overlapping batches, including Portal deliveries. */
export interface PersonalOrganizationUpgradeService {
  inviteStatus(
    this: void,
    organizationId: string,
    email: string,
  ): Promise<OrganizationInviteStatus>;
  status(
    this: void,
    operationId: string,
    sessionId?: string,
  ): Promise<PersonalProjectOperation | null>;
  convert(
    this: void,
    request: PersonalProjectConversionRequest,
    sessionId?: string,
    retry?: boolean,
  ): Promise<PersonalProjectOperation>;
  list(this: void): Promise<{ projects: PersonalProject[] }>;
  promote(
    this: void,
    request: UpgradePersonalOrganizationRequest,
  ): Promise<PersonalOrganizationPromotionOutcome>;
  invite(
    this: void,
    organizationId: string,
    request: SendOrganizationInviteRequest,
  ): Promise<OrganizationInviteResult>;
  resume(this: void): Promise<void>;
}
export function createPersonalOrganizationUpgradeService(
  deps: PersonalOrganizationUpgradeDeps,
): PersonalOrganizationUpgradeService {
  let pending: Promise<void> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = pending.then(run);
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function guard(
    identity: UpgradeIdentity,
    sessionId?: string,
  ): Promise<void> {
    const current = await deps.identity();
    if (
      current.accountId !== identity.accountId ||
      current.epoch !== identity.epoch ||
      (sessionId !== undefined && !deps.sessionCurrent(sessionId))
    )
      throw new Error('account-changed');
  }
  async function status(
    operationId: string,
    sessionId?: string,
  ): Promise<PersonalProjectOperation | null> {
    const identity = await deps.identity();
    const operation = (await deps.journal.read()).find(
      (entry) =>
        entry.accountId === identity.accountId &&
        entry.operationId === operationId,
    );
    await guard(identity);
    if (!operation || operation.desktopSessionId !== sessionId) return null;
    return operation;
  }
  async function convert(
    request: PersonalProjectConversionRequest,
    sessionId?: string,
    retry = false,
    expectedIdentity?: UpgradeIdentity,
  ): Promise<PersonalProjectOperation> {
    const input = PersonalProjectConversionRequestSchema.parse(request);
    const initiatingIdentity = expectedIdentity ?? (await deps.identity());
    return serial(async () => {
      let identity = initiatingIdentity;
      await guard(identity, sessionId);
      if (!(await deps.destination(input.organizationId, identity)))
        throw new Error('Destination unavailable');
      await guard(identity, sessionId);
      const selection = Array.from(new Set(input.workspaceIds));
      if (input.retryWorkspaceIds?.some((id) => !selection.includes(id)))
        throw new Error('Retry project was not selected');
      if (input.workspaceId && !selection.includes(input.workspaceId))
        throw new Error('Project was not selected');
      const recordedOperations = await deps.journal.read();
      const existing = recordedOperations.find(
        (entry) =>
          entry.accountId === identity.accountId &&
          entry.operationId === input.operationId,
      );
      if (existing && existing.desktopSessionId !== sessionId)
        throw new Error('Desktop session changed');
      if (
        existing &&
        (existing.organizationId !== input.organizationId ||
          JSON.stringify(existing.selection) !== JSON.stringify(selection))
      )
        throw new Error('Operation payload changed');
      let operation: PersonalProjectOperation = existing ?? {
        operationId: input.operationId,
        accountId: identity.accountId,
        organizationId: input.organizationId,
        ...(sessionId ? { desktopSessionId: sessionId } : {}),
        selection,
        projects: selection.map((workspaceId) => ({
          workspaceId,
          stage: 'queued',
          outcome: 'pending',
          creationStarted: false,
        })),
        updatedAt: deps.now(),
      };
      await deps.journal.update(operation);
      async function save(): Promise<void> {
        operation = { ...operation, updatedAt: deps.now() };
        await deps.journal.update(operation);
      }
      try {
        identity = await deps.refreshAccount(identity);
        await guard(identity, sessionId);
        await deps.switchContext(input.organizationId);
        await guard(identity, sessionId);
      } catch (error) {
        for (const entry of operation.projects) {
          if (
            entry.outcome !== 'pending' &&
            entry.outcome !== 'converted-private'
          )
            continue;
          if (error instanceof Error && error.message === 'account-changed')
            entry.outcome = 'account-changed';
          entry.reason =
            error instanceof Error
              ? error.message
              : 'Account refresh unavailable';
        }
        await save();
        return operation;
      }
      const initial = await deps.workspaces();
      const ordered = [...operation.projects].sort(
        (a, b) =>
          Number(
            initial.find((w) => w.workspaceId === a.workspaceId)?.kind ===
              'multi-repo',
          ) -
          Number(
            initial.find((w) => w.workspaceId === b.workspaceId)?.kind ===
              'multi-repo',
          ),
      );
      let prerequisiteFailed = false;
      for (const entry of ordered) {
        if (input.workspaceId && entry.workspaceId !== input.workspaceId)
          continue;
        if (entry.outcome === 'moved') {
          if (
            entry.refreshWarning &&
            input.retryWorkspaceIds?.includes(entry.workspaceId)
          ) {
            try {
              await guard(identity, sessionId);
              await deps.refreshCatalog(operation.organizationId);
              await guard(identity, sessionId);
              entry.refreshWarning = false;
              await save();
            } catch {
              prerequisiteFailed = true;
            }
          }
          continue;
        }
        if (
          !retry &&
          !input.retryWorkspaceIds?.includes(entry.workspaceId) &&
          !['pending', 'converted-private'].includes(entry.outcome)
        )
          continue;
        try {
          await guard(identity, sessionId);
          const workspace = (await deps.workspaces()).find(
            (w) => w.workspaceId === entry.workspaceId,
          );
          if (!workspace) {
            entry.outcome = 'workspace-not-found';
            await save();
            continue;
          }
          const unresolved = recordedOperations.find(
            (other) =>
              other.accountId === identity.accountId &&
              other.operationId !== operation.operationId &&
              other.projects.some(
                (project) =>
                  project.workspaceId === entry.workspaceId &&
                  ((project.creationStarted !== false &&
                    (project.outcome === 'pending' ||
                      project.outcome === 'converted-private')) ||
                    project.stage === 'member-created' ||
                    project.stage === 'converted'),
              ),
          );
          if (!workspace.owner && unresolved) {
            entry.outcome = 'pending';
            entry.reason = `Reconcile pending conversion ${unresolved.operationId} before starting another operation`;
            await save();
            continue;
          }
          if (
            workspace.owner &&
            (entry.projectId === undefined ||
              workspace.owner.organizationId !== operation.organizationId ||
              (entry.projectId !== undefined &&
                workspace.owner.projectId !== entry.projectId))
          ) {
            entry.outcome = 'not-personal';
            await save();
            continue;
          }
          if (workspace.owner) {
            entry.projectId = workspace.owner.projectId;
            entry.stage = 'converted';
          }
          const beforeMutation = async (): Promise<void> => {
            await guard(identity, sessionId);
            if (!(await deps.destination(operation.organizationId, identity)))
              throw new Error('Destination unavailable');
            await guard(identity, sessionId);
          };
          const onMemberCreated = async (projectId: string): Promise<void> => {
            entry.projectId = projectId;
            entry.stage = 'member-created';
            await save();
          };
          if (workspace.kind === 'multi-repo' && !workspace.owner) {
            const singlePending = operation.projects.some(
              (p) =>
                initial.find((w) => w.workspaceId === p.workspaceId)?.kind ===
                  'single-repo' && p.outcome === 'pending',
            );
            if (singlePending || prerequisiteFailed) {
              entry.outcome = 'pending';
              entry.reason =
                'Waiting for single-repository projects and catalog refresh';
              await save();
              continue;
            }
            await deps.refreshCatalog(operation.organizationId);
            await guard(identity, sessionId);
          }
          if (!workspace.owner) {
            await beforeMutation();
            entry.name ??= workspace.name;
            entry.kind ??= workspace.kind;
            entry.creationStarted = true;
            await save();
            const options: OrgMemberCreationOptions = {
              propagateErrors: true,
              beforeMutation,
              onMemberCreated,
              credentialContext: identity.credentials,
            };
            const creationKey = createHash('sha256')
              .update(`${operation.operationId}:${workspace.workspaceId}`)
              .digest('hex');
            const creationWorkspace =
              workspace.name === entry.name
                ? workspace
                : { ...workspace, name: entry.name };
            const result =
              workspace.kind === 'single-repo'
                ? await deps.createSingle(
                    creationWorkspace,
                    operation.organizationId,
                    creationKey,
                    entry.projectId,
                    options,
                  )
                : await deps.createMulti(
                    creationWorkspace,
                    operation.organizationId,
                    options,
                  );
            await guard(identity, sessionId);
            if (!result.ok) {
              entry.outcome =
                result.code === 'limit-reached'
                  ? 'limit-reached'
                  : result.code === 'refused'
                    ? 'repositories-not-in-team'
                    : result.code === 'unavailable'
                      ? 'offline'
                      : result.code === 'setup-failed'
                        ? 'pending'
                        : 'failed';
              entry.reason =
                result.code === 'refused'
                  ? `${result.reason}${'repositories' in result && Array.isArray(result.repositories) ? `: ${result.repositories.join(', ')}` : ''}`
                  : result.code;
              await save();
              continue;
            }
            entry.projectId = result.organizationProjectId;
            entry.stage = 'converted';
            entry.outcome = 'converted-private';
            await save();
          }
          if (!entry.projectId) throw new Error('Missing converted project');
          await beforeMutation();
          await deps.share(operation.organizationId, entry.projectId, identity);
          entry.stage = 'shared';
          entry.outcome = 'moved';
          await save();
          await guard(identity, sessionId);
          try {
            await deps.refreshCatalog(operation.organizationId);
          } catch {
            entry.refreshWarning = true;
            prerequisiteFailed = true;
          }
          entry.stage = 'complete';
          await save();
        } catch (error) {
          const changed =
            error instanceof Error && error.message === 'account-changed';
          entry.outcome =
            entry.stage === 'shared' || entry.stage === 'complete'
              ? 'moved'
              : changed
                ? 'account-changed'
                : entry.stage === 'converted'
                  ? 'converted-private'
                  : 'pending';
          entry.reason =
            error instanceof Error ? error.message : 'Unknown outcome';
          await save();
          if (changed) {
            for (const remaining of operation.projects)
              if (remaining.outcome === 'pending')
                remaining.outcome = 'account-changed';
            await save();
            break;
          }
          if (entry.stage === 'queued' || entry.stage === 'member-created')
            prerequisiteFailed = true;
        }
      }
      return operation;
    });
  }
  return {
    status,
    convert,
    async list(): Promise<{ projects: PersonalProject[] }> {
      const identity = await deps.identity();
      const workspaces = await deps.workspaces();
      await guard(identity);
      return {
        projects: workspaces
          .filter((w) => !w.owner)
          .map(({ workspaceId, name, kind }) => ({ workspaceId, name, kind })),
      };
    },
    async promote(
      request: UpgradePersonalOrganizationRequest,
    ): Promise<PersonalOrganizationPromotionOutcome> {
      let identity = await deps.identity();
      await guard(identity);
      const promotion = await deps.promote(request, identity);
      const warnings: PersonalOrganizationPromotionOutcome['warnings'] = [];
      let contextSwitched = false;
      try {
        await deps.suppress(promotion.organizationId);
      } catch {
        warnings.push('local-suppression-failed');
      }
      try {
        await guard(identity);
        identity = await deps.refreshAccount(identity);
      } catch {
        warnings.push('account-refresh-failed');
      }
      try {
        await guard(identity);
        await deps.switchContext(promotion.organizationId);
        await guard(identity);
        contextSwitched = true;
      } catch {
        warnings.push('context-switch-failed');
      }
      return { promotion, warnings, contextSwitched };
    },
    async invite(
      organizationId: string,
      request: SendOrganizationInviteRequest,
    ): Promise<OrganizationInviteResult> {
      const identity = await deps.identity();
      await guard(identity);
      return deps.invite(organizationId, request, identity);
    },
    async inviteStatus(
      organizationId,
      email,
    ): Promise<OrganizationInviteStatus> {
      const identity = await deps.identity();
      const result = await deps.inviteStatus(organizationId, email, identity);
      await guard(identity);
      return result;
    },
    async resume(): Promise<void> {
      const identity = await deps.identity();
      for (const entry of await deps.journal.read()) {
        if (
          entry.accountId !== identity.accountId ||
          (entry.desktopSessionId &&
            !deps.sessionCurrent(entry.desktopSessionId)) ||
          !entry.projects.some(
            (p) => p.outcome === 'pending' || p.outcome === 'converted-private',
          )
        )
          continue;
        await convert(
          {
            operationId: entry.operationId,
            organizationId: entry.organizationId,
            workspaceIds: entry.selection,
          },
          entry.desktopSessionId,
          false,
          identity,
        );
      }
    },
  };
}
