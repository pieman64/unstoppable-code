import { createHash } from 'node:crypto';
import type {
  CanopyCallerDescriptor,
  CanopyInstructionHandler,
  CanopyQueryHandler,
} from '@canopy/protocol/canopy-core';
import { SharedMultiRepoCreateCommandSchema } from '@canopy/protocol/canopy-core';
import type {
  CreateSharedMultiRepoParams,
  SharedMultiRepoCreateCommand,
  CreateSharedMultiRepoOrgProjectResponse,
  PrepareSharedMultiRepoParams,
  PreparedSharedMultiRepo,
  OrgProjectRepository,
  SharedMultiRepoCreationStatus,
  SharedMultiRepoCreationState,
} from '@canopy/protocol/org-projects';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';

/** Only a known selection refusal proves that no hosted request was accepted. */
export class SharedMultiRepoSelectionError extends Error {
  constructor(
    public readonly code:
      | 'stale_selection'
      | 'repository_mismatch'
      | 'cross_organization',
    message: string,
  ) {
    super(message);
    this.name = 'SharedMultiRepoSelectionError';
  }
}

export interface SharedMultiRepoCreationJournal {
  version: 1;
  accountId: string;
  deviceId: string;
  params: CreateSharedMultiRepoParams;
  requestDigest: string;
  status: SharedMultiRepoCreationStatus;
  createdAt: string;
}
export interface SharedMultiRepoJournalStore {
  read(
    accountId: string,
    creationKey: string,
  ): Promise<SharedMultiRepoCreationJournal | null>;
  list(accountId: string): Promise<SharedMultiRepoCreationJournal[]>;
  write(journal: SharedMultiRepoCreationJournal): Promise<void>;
}
export interface SharedMultiRepoPorts {
  identity(
    this: void,
    caller: CanopyCallerDescriptor,
  ): Promise<{ accountId: string; deviceId: string }>;
  authorize(
    this: void,
    caller: CanopyCallerDescriptor,
    organizationId: string,
  ): Promise<void>;
  inspect(
    this: void,
    caller: CanopyCallerDescriptor,
    params: PrepareSharedMultiRepoParams,
  ): Promise<PreparedSharedMultiRepo>;
  create(
    this: void,
    caller: CanopyCallerDescriptor,
    journal: SharedMultiRepoCreationJournal,
  ): Promise<CreateSharedMultiRepoOrgProjectResponse>;
  setup(
    this: void,
    caller: CanopyCallerDescriptor,
    journal: SharedMultiRepoCreationJournal,
  ): Promise<{
    state: 'ready' | 'setup-failed' | 'setup-cancelled' | 'completion-pending';
    errorCode?: string;
  }>;
  refresh(this: void, organizationId: string): Promise<void>;
  journal: SharedMultiRepoJournalStore;
  now(this: void): string;
  reportError(this: void, error: unknown): void;
}

function digest(params: CreateSharedMultiRepoParams): string {
  return createHash('sha256').update(JSON.stringify(params)).digest('hex');
}
function refusal(message: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    message,
    retry: { kind: 'never' },
  });
}
function failure(error: unknown): { status?: number; code?: string } {
  if (typeof error !== 'object' || error === null) return {};
  // Gateway responses cannot establish that the hosted write was rejected.
  if (
    'isValidatedServerError' in error &&
    error.isValidatedServerError === false
  )
    return {};
  return {
    status:
      'status' in error && typeof error.status === 'number'
        ? error.status
        : undefined,
    code:
      'serverCode' in error && typeof error.serverCode === 'string'
        ? error.serverCode
        : 'code' in error && typeof error.code === 'string'
          ? error.code
          : undefined,
  };
}
function publicStatus(
  journal: SharedMultiRepoCreationJournal,
): SharedMultiRepoCreationStatus {
  return { ...journal.status };
}

/** Core owns immutable requests; closing an observer has no cancellation effect. */
export function createSharedMultiRepoCoordinator(ports: SharedMultiRepoPorts): {
  prepare(
    caller: CanopyCallerDescriptor,
    params: PrepareSharedMultiRepoParams,
  ): Promise<PreparedSharedMultiRepo>;
  create(
    caller: CanopyCallerDescriptor,
    params: SharedMultiRepoCreateCommand,
  ): Promise<SharedMultiRepoCreationStatus>;
  getCreation(
    caller: CanopyCallerDescriptor,
    key: string,
  ): Promise<SharedMultiRepoCreationStatus | null>;
  resumePending(caller: CanopyCallerDescriptor): Promise<void>;
  listCreations(
    caller: CanopyCallerDescriptor,
    limit?: number,
  ): Promise<SharedMultiRepoCreationStatus[]>;
} {
  const accepting = new Map<string, Promise<SharedMultiRepoCreationStatus>>();
  const running = new Map<string, Promise<void>>();
  async function save(
    journal: SharedMultiRepoCreationJournal,
    state: SharedMultiRepoCreationState,
    errorCode?: string,
  ): Promise<void> {
    journal.status = {
      ...journal.status,
      state,
      updatedAt: ports.now(),
      errorCode,
    };
    await ports.journal.write(journal);
  }
  async function drive(
    caller: CanopyCallerDescriptor,
    journal: SharedMultiRepoCreationJournal,
  ): Promise<void> {
    try {
      await ports.authorize(caller, journal.status.organizationId);
      if (!journal.status.projectId) {
        await save(journal, 'creating');
        let response: CreateSharedMultiRepoOrgProjectResponse;
        try {
          response = await ports.create(caller, journal);
        } catch (error) {
          const detail = failure(error);
          const state =
            detail.code === 'creation_retired'
              ? 'retired'
              : detail.code === 'creation_unconfirmed' ||
                  detail.status === undefined ||
                  detail.status >= 500 ||
                  detail.status === 408 ||
                  detail.status === 429
                ? 'create-unconfirmed'
                : detail.status === 401 ||
                    detail.status === 403 ||
                    detail.status === 404
                  ? 'access-blocked'
                  : 'rejected';
          await save(
            journal,
            state,
            detail.code?.slice(0, 64) ?? 'creation_unconfirmed',
          );
          return;
        }
        if (
          response.creationKey !== journal.params.request.creationKey ||
          response.project.organizationId !== journal.status.organizationId ||
          response.project.topology !== 'multi-repo' ||
          response.project.visibility !== 'organization'
        ) {
          await save(journal, 'create-unconfirmed', 'invalid_response');
          return;
        }
        journal.status.projectId = response.project.id;
        await save(journal, 'created');
        await ports
          .refresh(journal.status.organizationId)
          .catch(ports.reportError);
      }
      await ports.authorize(caller, journal.status.organizationId);
      await save(journal, 'setting-up');
      const result = await ports.setup(caller, journal);
      await save(journal, result.state, result.errorCode);
      await ports
        .refresh(journal.status.organizationId)
        .catch(ports.reportError);
    } catch (error) {
      // A failed write before POST cannot send it. After an uncertain POST,
      // the old persisted request still retains the same replay identity.
      await save(
        journal,
        journal.status.projectId ? 'setup-failed' : 'create-unconfirmed',
        'host_unavailable',
      ).catch(ports.reportError);
      ports.reportError(error);
    }
  }
  async function read(
    caller: CanopyCallerDescriptor,
    key: string,
  ): Promise<SharedMultiRepoCreationJournal | null> {
    const identity = await ports.identity(caller);
    const journal = await ports.journal.read(identity.accountId, key);
    if (!journal) return null;
    if (journal.deviceId !== identity.deviceId)
      throw refusal('This attempt belongs to another desktop');
    await ports.authorize(caller, journal.status.organizationId);
    return journal;
  }
  return {
    async prepare(caller, params): Promise<PreparedSharedMultiRepo> {
      await ports.identity(caller);
      return ports.inspect(caller, params);
    },
    async create(caller, raw): Promise<SharedMultiRepoCreationStatus> {
      const command = SharedMultiRepoCreateCommandSchema.parse(raw);
      const identity = await ports.identity(caller);
      const creationKey =
        'request' in command
          ? command.request.creationKey
          : command.creationKey;
      const lock = `${identity.accountId}:${identity.deviceId}:${creationKey}`;
      // Serialize acceptance across product keys so two submissions cannot both
      // miss an unresolved journal. Long-running setup remains per attempt.
      const acceptanceLock = `${identity.accountId}:${identity.deviceId}`;
      const pending = accepting.get(acceptanceLock);
      const accept = async (): Promise<SharedMultiRepoCreationStatus> => {
        let journal = await read(caller, creationKey);
        if (journal) {
          if ('request' in command && journal.requestDigest !== digest(command))
            throw refusal(
              'This creation key has a different immutable request',
            );
        } else {
          if (!('request' in command))
            throw refusal('The saved request is unavailable on this desktop');
          const params = command;
          // Unknown/corrupt versions in this account prevent replacement allocation.
          const known = await ports.journal.list(identity.accountId);
          if (
            known.some(
              (entry) =>
                entry.deviceId === identity.deviceId &&
                !entry.status.projectId &&
                entry.status.state !== 'rejected' &&
                entry.status.state !== 'retired' &&
                entry.status.organizationId === params.request.organizationId &&
                (entry.params.selections.some((selection) =>
                  params.selections.some(
                    (next) =>
                      next.kind === selection.kind && next.id === selection.id,
                  ),
                ) ||
                  entry.params.request.sourceProjects.some((source) =>
                    params.request.sourceProjects.some(
                      (next) => next.projectId === source.projectId,
                    ),
                  )),
            )
          )
            throw refusal(
              'An unconfirmed request already exists for this selection; retry its original creation key',
            );
          await ports.authorize(caller, params.request.organizationId);
          let rejection: string | undefined;
          try {
            const preview = await ports.inspect(caller, params);
            if (!preview.canCreate) rejection = 'forbidden';
            else if (
              preview.organizationId !== params.request.organizationId ||
              JSON.stringify(preview.sourceProjects) !==
                JSON.stringify(params.request.sourceProjects)
            )
              rejection = 'stale_selection';
          } catch (error) {
            if (!(error instanceof SharedMultiRepoSelectionError)) throw error;
            rejection = error.code;
          }
          journal = {
            version: 1,
            accountId: identity.accountId,
            deviceId: identity.deviceId,
            params,
            requestDigest: digest(params),
            createdAt: ports.now(),
            status: {
              creationKey: params.request.creationKey,
              organizationId: params.request.organizationId,
              deviceId: identity.deviceId,
              state: rejection ? 'rejected' : 'creating',
              ...(rejection ? { errorCode: rejection } : {}),
              updatedAt: ports.now(),
            },
          };
          // Durable intent before scheduling any hosted side effect.
          await ports.journal.write(journal);
        }
        const active = running.get(lock);
        if (
          active &&
          [
            'create-unconfirmed',
            'setup-failed',
            'setup-cancelled',
            'completion-pending',
            'access-blocked',
          ].includes(journal.status.state)
        ) {
          // The terminal status precedes the old run's final refresh. A
          // retry arriving in that gap must start after the run releases it.
          await active;
          const latest = await read(caller, creationKey);
          if (!latest)
            throw refusal('The saved request is unavailable on this desktop');
          journal = latest;
        }
        if (
          !running.has(lock) &&
          !['ready', 'retired', 'rejected'].includes(journal.status.state)
        ) {
          const work = drive(caller, journal).finally((): void => {
            running.delete(lock);
          });
          running.set(lock, work);
          void work.catch(ports.reportError);
        }
        return publicStatus(journal);
      };
      const work = pending
        ? pending.catch((): void => {}).then(accept)
        : accept();
      accepting.set(acceptanceLock, work);
      try {
        return await work;
      } finally {
        if (accepting.get(acceptanceLock) === work)
          accepting.delete(acceptanceLock);
      }
    },
    async resumePending(caller): Promise<void> {
      const identity = await ports.identity(caller);
      const entries = await ports.journal.list(identity.accountId);
      for (const entry of entries) {
        if (
          entry.deviceId !== identity.deviceId ||
          ['ready', 'retired', 'rejected', 'setup-cancelled'].includes(
            entry.status.state,
          )
        )
          continue;
        await this.create(caller, entry.params);
      }
    },
    async getCreation(
      caller,
      key,
    ): Promise<SharedMultiRepoCreationStatus | null> {
      const journal = await read(caller, key);
      return journal ? publicStatus(journal) : null;
    },
    async listCreations(
      caller,
      limit = 50,
    ): Promise<SharedMultiRepoCreationStatus[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw refusal('Invalid creation list limit');
      const identity = await ports.identity(caller);
      const entries = await ports.journal.list(identity.accountId);
      const visible: SharedMultiRepoCreationStatus[] = [];
      for (const entry of entries) {
        if (entry.deviceId !== identity.deviceId) continue;
        try {
          await ports.authorize(caller, entry.status.organizationId);
        } catch {
          continue;
        }
        visible.push(publicStatus(entry));
      }
      return visible
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);
    },
  };
}

export type SharedMultiRepoCoordinator = ReturnType<
  typeof createSharedMultiRepoCoordinator
>;
export interface SharedMultiRepoHost {
  load(): Promise<SharedMultiRepoCoordinator>;
}
export function createCoreSharedMultiRepoHandlers(host: SharedMultiRepoHost): {
  queries: {
    'core.workspace.sharedMultiRepo.prepare': CanopyQueryHandler<
      'core.workspace.sharedMultiRepo.prepare',
      CanopyHandlerContext
    >;
    'core.workspace.sharedMultiRepo.getCreation': CanopyQueryHandler<
      'core.workspace.sharedMultiRepo.getCreation',
      CanopyHandlerContext
    >;
    'core.workspace.sharedMultiRepo.listCreations': CanopyQueryHandler<
      'core.workspace.sharedMultiRepo.listCreations',
      CanopyHandlerContext
    >;
  };
  instructions: {
    'core.workspace.sharedMultiRepo.create': CanopyInstructionHandler<
      'core.workspace.sharedMultiRepo.create',
      CanopyHandlerContext
    >;
  };
} {
  return {
    queries: {
      'core.workspace.sharedMultiRepo.prepare': async (
        params,
        context,
      ): Promise<{
        organizationId: string;
        sourceProjects: { projectId: string; expectedRevision: number }[];
        repositories: OrgProjectRepository[];
        lockedProjectIds: string[];
        suggestedName: string;
        canCreate: boolean;
      }> => {
        const result = await (
          await host.load()
        ).prepare(context.caller, params);
        return {
          ...result,
          sourceProjects: [...result.sourceProjects],
          repositories: [...result.repositories],
          lockedProjectIds: [...result.lockedProjectIds],
        };
      },
      'core.workspace.sharedMultiRepo.getCreation': async (
        { creationKey },
        context,
      ) => (await host.load()).getCreation(context.caller, creationKey),
      'core.workspace.sharedMultiRepo.listCreations': async (
        { limit },
        context,
      ) => (await host.load()).listCreations(context.caller, limit),
    },
    instructions: {
      'core.workspace.sharedMultiRepo.create': async (params, context) =>
        (await host.load()).create(context.caller, params),
    },
  };
}
