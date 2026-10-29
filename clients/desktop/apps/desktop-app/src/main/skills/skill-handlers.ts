import {
  annotateSharedSkillInstalls,
  assertStoredSkillContext,
  filterStoredSkillContexts,
} from './skill-install-context';
import {
  toShareOperationResult,
  withShareStage,
} from '../sharing/share-operation-result';
import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import type {
  AnalyzeSkillCapabilityPackageRequest,
  CommitSkillCapabilityPackageRequest,
  InstallSkillCapabilityPackageRequest,
  CreateSharedSkillRequest,
  DeleteSharedSkillRequest,
  ListSharedSkillsRequest,
  SaveCustomSkillRequest,
  RecordSkillShareOriginRequest,
  SkillUpdateProgress,
  UpdateSharedSkillRequest,
  WriteRawSkillRequest,
} from '@canopy/desktop-shared/types/skills';
import type { IPCResult } from '@canopy/desktop-shared/types/pipeline';
import type { IpcMainInvokeEvent } from 'electron';
import { BrowserWindow } from 'electron';
import {
  analyzeSkillCapabilityPackage,
  cancelPackageAnalysis,
  createSubjectCapabilityPackage,
} from '../pipelines/pipeline-package-service';
import { installSkillCapabilityPackage } from './skill-package-install';
import {
  getSkillDependencyReadiness,
  normalizeSkillDependencyReadinessRequest,
} from './skill-dependency-readiness';
import {
  assertCanopyCloudCapability,
  resolveCanopyCloudCredentialContext,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import { registerIpcHandler } from '../ipc/register';
import { refreshInvocableInventoryAfterMutation } from '../plugins/invocable-inventory-service';
import * as service from './skill-service';
import { listDesktopPublisherSkills } from './publisher-marketplace';
import {
  createSharedSkill,
  deleteSharedSkill,
  getSharedSkill,
  listSharedSkills,
  publishSkillPublicShare,
  revokeSkillPublicShare,
  updateSharedSkill,
} from './canopy-server-client';
import { insertCapabilityPackageInstallIfAbsent } from '../pipelines/pipeline-package-install-store';
import { getPipelinePackageInstallStorePath } from '../lib/paths';
import { sendToWebContents } from '../lib/web-contents-send';

const SKILLS_CAPABILITY = 'skills-crud-v1';

async function assertSkillsSupported(
  credentials?: CanopyCloudCredentialContext,
): Promise<void> {
  if (credentials) {
    await assertCanopyCloudCapability(SKILLS_CAPABILITY, credentials);
  } else {
    await assertCanopyCloudCapability(SKILLS_CAPABILITY);
  }
}

async function resolveSkillShareCredentials(): Promise<{
  credentialContext: CanopyCloudCredentialContext;
  accountId: string;
}> {
  const credentialContext = await resolveCanopyCloudCredentialContext();
  const accountId = credentialContext.account?.id.trim();
  if (!accountId) {
    throw new Error('The connected account could not be identified.');
  }
  return { credentialContext, accountId };
}

export function registerSkillHandlers(): void {
  registerIpcHandler(SKILLS_CHANNELS.MARKETPLACE_LIST, () =>
    listDesktopPublisherSkills(),
  );
  const refreshAfterSuccess = async <T>(
    reason: string,
    operation: () => Promise<IPCResult<T>> | IPCResult<T>,
  ): Promise<IPCResult<T>> => {
    const result = await operation();
    if (result.success) {
      refreshInvocableInventoryAfterMutation(reason);
    }
    return result;
  };

  const progressFor = (
    event: IpcMainInvokeEvent,
  ): ((progress: SkillUpdateProgress) => void) => {
    return (progress) => {
      sendToWebContents(
        event.sender,
        SKILLS_CHANNELS.UPDATE_PROGRESS,
        progress,
      );
    };
  };

  registerIpcHandler(SKILLS_CHANNELS.LOAD, async () => {
    const result = service.loadSkills();
    if (result.success && result.data)
      return {
        ...result,
        data: await annotateSharedSkillInstalls(
          await filterStoredSkillContexts(result.data),
        ),
      };
    return result;
  });
  registerIpcHandler(
    SKILLS_CHANNELS.FETCH_AVAILABLE,
    (_event, source: string) => service.fetchAvailable(source),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.INSTALL,
    (_event, source: string, skillNames: string[]) =>
      refreshAfterSuccess('skills:install', () =>
        service.installSkills(source, skillNames),
      ),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.REMOVE,
    async (_event, sourceId: string, skillName: string) => {
      await assertStoredSkillContext(`${sourceId}/${skillName}`);
      return refreshAfterSuccess('skills:remove', () =>
        service.removeSkill(sourceId, skillName),
      );
    },
  );
  registerIpcHandler(
    SKILLS_CHANNELS.UPDATE,
    async (_event, sourceId: string, skillName: string) => {
      await assertStoredSkillContext(`${sourceId}/${skillName}`);
      return refreshAfterSuccess('skills:update', () =>
        service.updateSkill(sourceId, skillName),
      );
    },
  );
  registerIpcHandler(SKILLS_CHANNELS.CHECK_UPDATES, (event) =>
    service.checkUpdates(progressFor(event)),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.READ_CONTENT,
    async (_event, sourceId: string, skillName: string) => {
      await assertStoredSkillContext(`${sourceId}/${skillName}`);
      return service.readSkillContent(sourceId, skillName);
    },
  );
  registerIpcHandler(
    SKILLS_CHANNELS.LIST_FILES,
    async (_event, sourceId: string, skillName: string) => {
      await assertStoredSkillContext(`${sourceId}/${skillName}`);
      return service.listSkillFiles(sourceId, skillName);
    },
  );
  registerIpcHandler(
    SKILLS_CHANNELS.READ_FILE,
    async (_event, sourceId: string, skillName: string, filePath: string) => {
      await assertStoredSkillContext(`${sourceId}/${skillName}`);
      return service.readSkillFile(sourceId, skillName, filePath);
    },
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SAVE_CUSTOM,
    (_event, payload: SaveCustomSkillRequest) =>
      refreshAfterSuccess('skills:save-custom', () =>
        service.saveCustomSkill(payload),
      ),
  );
  registerIpcHandler(SKILLS_CHANNELS.READ_RAW, (_event, skillId: string) =>
    service.readRawSkill(skillId),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.WRITE_RAW,
    async (_event, input: WriteRawSkillRequest) => {
      const result = await service.writeRawSkillForContext(input);
      refreshInvocableInventoryAfterMutation('skills:write-raw');
      return result;
    },
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SHARED_LIST,
    async (_event, request: ListSharedSkillsRequest) => {
      await assertSkillsSupported();
      return listSharedSkills(request);
    },
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SHARED_GET,
    async (_event, skillId: string) => {
      await assertSkillsSupported();
      return getSharedSkill(skillId);
    },
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SHARED_CREATE,
    (_event, request: CreateSharedSkillRequest) =>
      toShareOperationResult(async () => {
        const credentials = await withShareStage('access', async () => {
          const resolved = request.sourceSkillId
            ? await resolveSkillShareCredentials()
            : undefined;
          await assertSkillsSupported(resolved?.credentialContext);
          return resolved;
        });
        const detail = credentials
          ? await createSharedSkill(request, credentials.credentialContext)
          : await createSharedSkill(request);
        const { sourceSkillId } = request;
        if (sourceSkillId && credentials && detail.canUpdate) {
          // Skill creation is content-addressed and can return an older,
          // deduplicated row. A failed local write therefore cannot safely
          // compensate by deleting the returned remote id; the share landed.
          await withShareStage('finish', () => {
            service.writeSkillRemoteMetadata(sourceSkillId, {
              accountId: credentials.accountId,
              remoteId: detail.id,
              contentHash: detail.contentHash,
              shareScope: detail.shareScope,
              sharedAt: detail.updatedAt,
            });
            return Promise.resolve();
          });
        }
        return detail;
      }),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SHARED_UPDATE,
    (_event, request: UpdateSharedSkillRequest) =>
      toShareOperationResult(async () => {
        const credentials = await withShareStage('access', async () => {
          const resolved = request.sourceSkillId
            ? await resolveSkillShareCredentials()
            : undefined;
          await assertSkillsSupported(resolved?.credentialContext);
          return resolved;
        });
        const detail = credentials
          ? await updateSharedSkill(request, credentials.credentialContext)
          : await updateSharedSkill(request);
        const { sourceSkillId } = request;
        if (sourceSkillId && credentials) {
          // The update has landed; only storing its local link can fail here.
          await withShareStage('finish', () => {
            service.writeSkillRemoteMetadata(sourceSkillId, {
              accountId: credentials.accountId,
              remoteId: detail.id,
              contentHash: detail.contentHash,
              shareScope: detail.shareScope,
              sharedAt: detail.updatedAt,
            });
            return Promise.resolve();
          });
        }
        return detail;
      }),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SHARED_DELETE,
    async (_event, request: DeleteSharedSkillRequest) => {
      await assertSkillsSupported();
      await deleteSharedSkill(request);
      service.clearSkillRemoteMetadataByRemoteId(request.skillId);
    },
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SHARED_PUBLISH_PUBLIC,
    async (_event, skillId: string) => {
      await assertSkillsSupported();
      return publishSkillPublicShare(skillId);
    },
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SHARED_REVOKE_PUBLIC,
    async (_event, skillId: string) => {
      await assertSkillsSupported();
      await revokeSkillPublicShare(skillId);
    },
  );

  // ---- Capability package -------------------------------------------------
  //
  // Analysis is local work over the skill folder and the invocable inventory,
  // so it deliberately does NOT assert the cloud capability: a publisher can
  // review what would travel before deciding to share. The commit uploads
  // blobs and does assert it.
  registerIpcHandler(
    SKILLS_CHANNELS.PACKAGE_ANALYZE,
    (_event, request: AnalyzeSkillCapabilityPackageRequest) =>
      analyzeSkillCapabilityPackage(request),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.PACKAGE_CANCEL_ANALYSIS,
    (_event, analysisId: string) => {
      cancelPackageAnalysis(analysisId);
    },
  );
  registerIpcHandler(
    SKILLS_CHANNELS.PACKAGE_INSTALL,
    async (_event, request: InstallSkillCapabilityPackageRequest) => {
      // A public share's package endpoints are anonymous, exactly like a
      // public pipeline or automation package, so a signed-out recipient of a
      // public link gets the whole skill. Only an owned team or organization
      // package needs the account and its skills capability.
      if (request.publicShare !== true) await assertSkillsSupported();
      const result = await installSkillCapabilityPackage(request);
      refreshInvocableInventoryAfterMutation('skills:package-install');
      return result;
    },
  );
  // Local-only, like analysis: a recipient sees what a shared skill needs on
  // this machine before deciding to install it, signed in or not.
  registerIpcHandler(
    SKILLS_CHANNELS.DEPENDENCY_READINESS,
    (_event, request: unknown) =>
      getSkillDependencyReadiness(
        normalizeSkillDependencyReadinessRequest(request),
      ),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.PACKAGE_COMMIT,
    (event, request: CommitSkillCapabilityPackageRequest) =>
      toShareOperationResult(async () => {
        await assertSkillsSupported();
        return createSubjectCapabilityPackage(request, () =>
          BrowserWindow.fromWebContents(event.sender),
        );
      }, 'prepare'),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.RECORD_SHARE_ORIGIN,
    async (_event, request: RecordSkillShareOriginRequest) => {
      const storePath = getPipelinePackageInstallStorePath();
      const owner = { kind: 'skill' as const, localId: request.localId };
      await insertCapabilityPackageInstallIfAbsent(storePath, {
        owner,
        originExternalId: request.originExternalId,
        pipelineContentHash: request.contentHash,
        distributionMode: 'definition_only',
        installedAt: new Date().toISOString(),
      });
    },
  );
}
