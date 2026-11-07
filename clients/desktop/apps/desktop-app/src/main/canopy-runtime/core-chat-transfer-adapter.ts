import type {
  ChatSessionCloudExportDeleteResponse,
  ChatSessionCloudExportListRequest,
  ChatSessionCloudExportListResponse,
  ChatSessionExportRequest,
  ChatSessionExportResponse,
  ChatSessionImportInspectRequest,
  ChatSessionImportInspectResponse,
  ChatSessionImportRequest,
  ChatSessionImportResponse,
  SessionCloudExportRepoSummary,
} from '@canopy/desktop-shared/types';
import {
  CoreChatTransferDeleteResultSchema,
  CoreChatTransferExportResultSchema,
  CoreChatTransferImportDiscardResultSchema,
  CoreChatTransferImportResultSchema,
  type CanopyCallerDescriptor,
  type CanopyQueryHandlerMap,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  canopyInvalidArgumentError,
  canopyPermissionDeniedError,
  type CanopyDispatcherInstructionHandlerMap,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import { validateId } from '../lib/validation';
import type { DesktopInstructionDefinitions } from './desktop-instruction-definitions';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

/** The session transfer functions behind `core.chat.transfer.*` (CAN-4113). */
export interface CoreChatTransferHost {
  list(
    request: ChatSessionCloudExportListRequest,
  ): Promise<ChatSessionCloudExportListResponse>;
  export(request: ChatSessionExportRequest): Promise<ChatSessionExportResponse>;
  delete(exportId: string): Promise<ChatSessionCloudExportDeleteResponse>;
  inspect(
    request: ChatSessionImportInspectRequest,
  ): Promise<ChatSessionImportInspectResponse>;
  import(request: ChatSessionImportRequest): Promise<ChatSessionImportResponse>;
  discard(exportId: string): Promise<void>;
}

/** Electron main's session transfer, loaded on first use. */
export function createDesktopChatTransferHost(): CoreChatTransferHost {
  return {
    list: async (request) => {
      const transfer = await import('../lib/session-transfer');
      return transfer.listSessionExports(request);
    },
    export: async (request) => {
      const transfer = await import('../lib/session-transfer');
      return transfer.exportChatSession(request);
    },
    delete: async (exportId) => {
      const transfer = await import('../lib/session-transfer');
      return transfer.deleteSessionExport(exportId);
    },
    inspect: async (request) => {
      const transfer = await import('../lib/session-transfer');
      return transfer.inspectChatSessionImport(request);
    },
    import: async (request) => {
      const transfer = await import('../lib/session-transfer');
      const { getMainWindow } = await import('../lib/main-window-focus');
      return transfer.importChatSession(request, getMainWindow);
    },
    discard: async (exportId) => {
      const transfer = await import('../lib/session-transfer');
      return transfer.discardStagedSessionImport(exportId);
    },
  };
}

export type CoreChatTransferInstructionName =
  | 'core.chat.transfer.export'
  | 'core.chat.transfer.delete'
  | 'core.chat.transfer.import.inspect'
  | 'core.chat.transfer.import'
  | 'core.chat.transfer.import.discard';

const WARNING_MAX = 2048;
const TEXT_MAX = 4096;
const NAME_MAX = 1024;
const SHORT_MAX = 64;

function cap(text: string, max: number): string {
  return text.slice(0, max);
}

function capOptional(
  text: string | undefined,
  max: number,
): string | undefined {
  return text === undefined ? undefined : cap(text, max);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnings(values: readonly string[]): string[] {
  return values.map((value) => cap(value, WARNING_MAX));
}

function summaryRepo(repo: SessionCloudExportRepoSummary): {
  name: string;
  branchName: string;
  remoteUrl?: string;
} {
  const remoteUrl = capOptional(repo.remoteUrl, TEXT_MAX);
  return {
    name: cap(repo.name, NAME_MAX),
    branchName: cap(repo.branchName, NAME_MAX),
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
  };
}

function importRepo(repo: {
  name: string;
  remoteUrl?: string;
  branchName?: string;
}): { name: string; remoteUrl?: string; branchName?: string } {
  const remoteUrl = capOptional(repo.remoteUrl, TEXT_MAX);
  const branchName = capOptional(repo.branchName, NAME_MAX);
  return {
    name: cap(repo.name, NAME_MAX),
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
    ...(branchName === undefined ? {} : { branchName }),
  };
}

function guardCaller(caller: CanopyCallerDescriptor): void {
  if (caller.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID) {
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'The selected chat authority is unavailable.',
      retry: { kind: 'never' },
    });
  }
  if (caller.interfaceKind === 'portal') {
    throw canopyPermissionDeniedError(
      'Portal clients cannot transfer chat sessions.',
    );
  }
}

function validateIds(ids: Record<string, string>): void {
  try {
    for (const [name, value] of Object.entries(ids)) validateId(value, name);
  } catch (error) {
    throw canopyInvalidArgumentError(messageOf(error));
  }
}

function withoutMeta(params: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([name]) => name !== '_meta'),
  );
}

async function attempt<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new CanopyOperationError(
      {
        kind: 'failed_precondition',
        code: 'core.chat.transfer.failed',
        message: cap(messageOf(error), WARNING_MAX) || 'Chat transfer failed.',
        retry: { kind: 'never' },
      },
      error,
    );
  }
}

export function createCoreChatTransferAdapter(
  host: CoreChatTransferHost = createDesktopChatTransferHost(),
): {
  queries: Pick<
    CanopyQueryHandlerMap<CanopyHandlerContext>,
    'core.chat.transfer.list'
  >;
  instructions: Pick<
    CanopyDispatcherInstructionHandlerMap<DesktopInstructionDefinitions>,
    CoreChatTransferInstructionName
  >;
} {
  const keyed = new KeyedOutcomes<unknown>({
    reusedError: (): CanopyOperationError =>
      new CanopyOperationError({
        kind: 'conflict',
        code: 'core.chat.transfer.idempotencyKeyReused',
        message: 'This idempotency key was used with other parameters.',
        retry: { kind: 'never' },
      }),
  });
  const runKeyed = <T>(
    operation: CoreChatTransferInstructionName,
    context: CanopyHandlerContext,
    params: object,
    result: { parse(value: unknown): T },
    run: () => Promise<T>,
  ): Promise<T> =>
    keyed
      .run(context, { operation, ...withoutMeta(params) }, () => attempt(run))
      .then((outcome) => result.parse(outcome));

  return {
    queries: {
      'core.chat.transfer.list': async (params, context) => {
        guardCaller(context.caller);
        return attempt(async () => {
          const response = await host.list({
            ...(params.query === undefined ? {} : { q: params.query }),
            ...(params.cursor ? { cursor: params.cursor } : {}),
            ...(params.limit === undefined ? {} : { limit: params.limit }),
          });
          return {
            transfers: response.data.map(({ id, ...rest }) => ({
              transferId: id,
              title: cap(rest.title, TEXT_MAX),
              workspaceName: cap(rest.workspaceName, NAME_MAX),
              workspaceType: cap(rest.workspaceType, SHORT_MAX),
              repos: rest.repos.map(summaryRepo),
              sizeBytes: rest.sizeBytes,
              createdAt: cap(rest.createdAt, SHORT_MAX),
              updatedAt: cap(rest.updatedAt, SHORT_MAX),
            })),
            nextCursor: response.nextCursor,
          };
        });
      },
    },
    instructions: {
      'core.chat.transfer.export': async (params, context) => {
        guardCaller(context.caller);
        validateIds({
          projectId: params.projectId,
          worktreeId: params.worktreeId,
          chatId: params.chatId,
        });
        return runKeyed(
          'core.chat.transfer.export',
          context,
          params,
          CoreChatTransferExportResultSchema,
          async () => {
            const response = await host.export({
              projectId: params.projectId,
              worktreeId: params.worktreeId,
              chatId: params.chatId,
            });
            return {
              transferId: response.exportId,
              title: cap(response.title, TEXT_MAX),
              sizeBytes: response.sizeBytes,
              warnings: warnings(response.warnings),
            };
          },
        );
      },
      'core.chat.transfer.delete': async (params, context) => {
        guardCaller(context.caller);
        validateIds({ exportId: params.transferId });
        return runKeyed(
          'core.chat.transfer.delete',
          context,
          params,
          CoreChatTransferDeleteResultSchema,
          async () => {
            await host.delete(params.transferId);
            return { deleted: true as const };
          },
        );
      },
      'core.chat.transfer.import.inspect': async (params, context) => {
        guardCaller(context.caller);
        validateIds({
          exportId: params.transferId,
          workspaceId: params.workspaceId,
        });
        return attempt(async () => {
          const { exportId, ...response } = await host.inspect({
            workspaceId: params.workspaceId,
            exportId: params.transferId,
          });
          const provider = capOptional(
            response.manifestSummary.provider,
            SHORT_MAX,
          );
          return {
            transferId: exportId,
            manifestSummary: {
              title: cap(response.manifestSummary.title, TEXT_MAX),
              ...(provider === undefined ? {} : { provider }),
              exportedAt: cap(response.manifestSummary.exportedAt, SHORT_MAX),
              workspaceType: response.manifestSummary.workspaceType,
              repoCount: response.manifestSummary.repoCount,
              repos: response.manifestSummary.repos.map(importRepo),
            },
            workspaceSummary: {
              workspaceId: response.workspaceSummary.workspaceId,
              workspaceName: cap(
                response.workspaceSummary.workspaceName,
                NAME_MAX,
              ),
              workspaceType: response.workspaceSummary.workspaceType,
              repoCount: response.workspaceSummary.repoCount,
              repos: response.workspaceSummary.repos.map(importRepo),
            },
            match: response.match,
            workspaceTypeCompatible: response.workspaceTypeCompatible,
            missingRepos: response.missingRepos.map((repo) => {
              const remoteUrl = capOptional(repo.remoteUrl, TEXT_MAX);
              return {
                name: cap(repo.name, NAME_MAX),
                ...(remoteUrl === undefined ? {} : { remoteUrl }),
              };
            }),
            warnings: warnings(response.warnings),
            ...(response.capabilityReadiness === undefined
              ? {}
              : {
                  capabilityReadiness: response.capabilityReadiness.map(
                    ({ setupHint, ...readiness }) => {
                      const hint = capOptional(setupHint, TEXT_MAX);
                      return {
                        ...readiness,
                        name: cap(readiness.name, NAME_MAX),
                        ...(hint === undefined ? {} : { setupHint: hint }),
                      };
                    },
                  ),
                }),
          };
        });
      },
      'core.chat.transfer.import': async (params, context) => {
        guardCaller(context.caller);
        validateIds({
          exportId: params.transferId,
          workspaceId: params.workspaceId,
        });
        return runKeyed(
          'core.chat.transfer.import',
          context,
          params,
          CoreChatTransferImportResultSchema,
          async () => {
            const response = await host.import({
              exportId: params.transferId,
              workspaceId: params.workspaceId,
              ...(params.installMissing === undefined
                ? {}
                : { installMissing: params.installMissing }),
            });
            return { ...response, warnings: warnings(response.warnings) };
          },
        );
      },
      'core.chat.transfer.import.discard': async (params, context) => {
        guardCaller(context.caller);
        validateIds({ exportId: params.transferId });
        return runKeyed(
          'core.chat.transfer.import.discard',
          context,
          params,
          CoreChatTransferImportDiscardResultSchema,
          async () => {
            await host.discard(params.transferId);
            return { discarded: true as const };
          },
        );
      },
    },
  };
}
