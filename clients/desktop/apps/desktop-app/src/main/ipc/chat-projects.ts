import type { ShareOperationResult } from '@canopy/protocol/sharing';
import {
  toShareOperationResult,
  withShareStage,
} from '../sharing/share-operation-result';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isChatTabPluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import {
  IPC_CHANNELS,
  type ChatProjectClaudeMdRequest,
  type ChatProjectData,
  type ChatProjectListResponse,
  type CreateChatProjectRequest,
  type CreateChatProjectResponse,
  type CreateChatProjectFromTemplateRequest,
  type CreateChatProjectFromTemplateResponse,
  type CreateOrgCoworkProjectRequest,
  type CreateOrgCoworkProjectResult,
  type ChatProjectTemplateShareInfo,
  type ChatProjectTemplateDocumentRequest,
  type ChatProjectTemplateDocumentResult,
  type ChatProjectTemplateShareRequest,
  type ChatProjectTemplatePackageAnalyzeRequest,
  type ChatProjectTemplatePackageCommitRequest,
  type ChatProjectTemplatePackageReadinessRequest,
  type ChatProjectTemplateShareRevokeRequest,
  type DeleteChatProjectRequest,
  type DesktopBlueprintCatalogResponse,
  type SaveChatProjectClaudeMdRequest,
  type UpdateChatProjectRequest,
} from '@canopy/desktop-shared/types';
import { syncChatProjectAgentsMd } from '../lib/chat-project-utils';
import {
  createCoworkWorkspace,
  createCoworkWorkspaceFromBlueprint,
  createCoworkWorkspaceFromTemplate,
  findCoworkWorkspaceTemplateInstall,
  listCoworkWorkspacesAsChatProjects,
  setCoworkWorkspaceTemplateInstallMetadata,
  clearCoworkWorkspaceTemplateShare,
  setCoworkWorkspaceTemplateShareMetadata,
  setCoworkWorkspaceTemplatePublicationKey,
  updateCoworkWorkspace,
} from '../lib/cowork-workspace-crud';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { deleteWorkspace } from '../lib/workspace-deletion';
import { getCoworkWorkspaceRootDir } from '../lib/paths';
import { validateId } from '../lib/validation';
import { assertStartPageFeatureEnabled } from '../lib/start-page-feature-flag';
import { recordStandaloneProjectCrudTelemetry } from '../lib/desktop-telemetry';
import { registerIpcHandler } from './register';
import {
  ensureOrgDefaultCoworkWorkspace,
  getOrgDefaultCoworkEligibility,
} from '../lib/org-cowork-binding-deps';
import {
  type SharedWorkspaceTemplateDocument,
  type ListWorkspaceTemplateSharesResponse,
  type ListWorkspaceTemplateSharesRequest,
  serializeSharedWorkspaceTemplateForHash,
  validateSharedWorkspaceTemplateDocument,
  WORKSPACE_TEMPLATE_SHARE_LABEL,
  WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER,
  workspaceTemplateSharePath,
} from '@canopy/protocol';
import {
  installDesktopWorkspaceTemplateCapabilityPackages,
  resolveDesktopWorkspaceTemplate,
} from '../plugins/workspace-template-import';
import {
  createWorkspaceTemplateShare,
  getWorkspaceTemplateShareSnapshot,
  listWorkspaceTemplateShares,
  republishWorkspaceTemplateShare,
  revokeWorkspaceTemplateShare,
} from '../canopy-cloud/workspace-template-client';
import {
  buildDesktopWorkspaceTemplateDocument,
  workspaceTemplateModelRequirements,
} from '../plugins/workspace-template-authoring';
import { serializeChatProjectOperation } from '../lib/chat-project-operation-queue';
import {
  listBlueprints,
  refreshBlueprints,
} from '../blueprints/blueprint-catalog';
import { resolveCuratedBlueprintSeed } from '../lib/curated-blueprint-seed';
import { getOrgCoworkCreator } from '../lib/org-cowork-create-deps';
import { reportShareHandoffEvent } from '../canopy-cloud/share-handoff-events';
import {
  analyzeSubjectCapabilityPackage,
  cancelPackageAnalysis,
  createSubjectCapabilityPackage,
  evaluatePipelinePackageRequirements,
  probePipelinePackageRequirement,
} from '../pipelines/pipeline-package-service';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePackageReadiness,
} from '@canopy/desktop-shared/types/pipeline';

function isRemoteNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 404
  );
}

async function listChatProjects(): Promise<ChatProjectListResponse> {
  return { projects: await listCoworkWorkspacesAsChatProjects() };
}

async function requireChatProject(projectId: string): Promise<ChatProjectData> {
  validateId(projectId, 'projectId');
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  const projects = await listCoworkWorkspacesAsChatProjects();
  const project = projects.find((entry) => entry.id === workspaceId);
  if (!project) {
    throw new Error('Chat project not found');
  }
  return project;
}

async function createChatProject(
  name: string,
): Promise<CreateChatProjectResponse> {
  const project = await createCoworkWorkspace(name);
  recordStandaloneProjectCrudTelemetry({
    action: 'create',
    projectId: project.id,
  });
  return { project };
}

async function updateChatProject(req: UpdateChatProjectRequest): Promise<void> {
  if (req.startPage !== undefined) {
    assertStartPageFeatureEnabled();
  }
  const workspaceId = resolveCoworkWorkspaceId(req.projectId);
  await updateCoworkWorkspace({ ...req, projectId: workspaceId });
  recordStandaloneProjectCrudTelemetry({
    action: 'update',
    projectId: workspaceId,
  });
}

async function deleteChatProject(req: DeleteChatProjectRequest): Promise<void> {
  validateId(req.projectId, 'projectId');
  if (req.chatDisposition !== 'move' && req.chatDisposition !== 'delete') {
    throw new Error('Invalid chatDisposition');
  }

  const workspaceId = resolveCoworkWorkspaceId(req.projectId);
  // The canonical deletion (W6c2) runs the delegate and background-work
  // admission in the workspace and sentinel scopes, tears down sessions and
  // removes the project. `coworkProject` refuses a code project or an
  // unindexed id as "Chat project not found" before any effect.
  await deleteWorkspace({
    workspaceId,
    source: 'chat_project_delete',
    coworkProject: true,
  });
  recordStandaloneProjectCrudTelemetry({
    action: 'delete',
    projectId: workspaceId,
    chatDisposition: req.chatDisposition,
  });
}

async function loadChatProjectClaudeMd(projectId: string): Promise<string> {
  await requireChatProject(projectId);
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  try {
    return await readFile(
      join(getCoworkWorkspaceRootDir(workspaceId), 'CLAUDE.md'),
      'utf8',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function saveChatProjectClaudeMd(
  req: SaveChatProjectClaudeMdRequest,
): Promise<void> {
  const project = await requireChatProject(req.projectId);
  const workspaceId = resolveCoworkWorkspaceId(project.id);
  const rootDir = getCoworkWorkspaceRootDir(workspaceId);
  await mkdir(rootDir, { recursive: true });
  await writeFile(join(rootDir, 'CLAUDE.md'), req.content, 'utf8');
  await syncChatProjectAgentsMd(project.id);
}

function validatedTemplateShareRequest(
  req: ChatProjectTemplateShareRequest,
): SharedWorkspaceTemplateDocument {
  const parsed = validateSharedWorkspaceTemplateDocument(req.document);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

async function getChatProjectTemplateShare(
  req: ChatProjectTemplateShareRequest,
): Promise<ChatProjectTemplateShareInfo | null> {
  const document = validatedTemplateShareRequest(req);
  return serializeChatProjectOperation(async () => {
    const project = await requireChatProject(req.projectId);
    if (
      project.sharedTemplateExternalId === undefined ||
      project.sharedTemplateContentHash === undefined
    ) {
      return null;
    }
    let snapshot;
    let summary;
    try {
      [snapshot, summary] = await Promise.all([
        getWorkspaceTemplateShareSnapshot(project.sharedTemplateExternalId),
        listWorkspaceTemplateShares().then((result) =>
          result.shares.find(
            (candidate) =>
              candidate.externalId === project.sharedTemplateExternalId,
          ),
        ),
      ]);
    } catch (error) {
      if (!isRemoteNotFound(error)) throw error;
      await clearCoworkWorkspaceTemplateShare(project.id, 'template_share_get');
      return null;
    }
    return {
      externalId: project.sharedTemplateExternalId,
      sharePath: workspaceTemplateSharePath(project.sharedTemplateExternalId),
      pinnedContentHash: project.sharedTemplateContentHash,
      upToDate:
        snapshot.contentHash === project.sharedTemplateContentHash &&
        JSON.stringify(snapshot.template) === JSON.stringify(document),
      ...(summary ? { audience: summary.audience, owner: summary.owner } : {}),
    };
  });
}

async function publishChatProjectTemplateShare(
  req: ChatProjectTemplateShareRequest,
): Promise<ChatProjectTemplateShareInfo> {
  // Nothing is published until the template share request, so a failed
  // check before it is definite.
  const document = await withShareStage('access', () =>
    Promise.resolve().then(() => validatedTemplateShareRequest(req)),
  );
  return serializeChatProjectOperation(async () => {
    const project = await withShareStage('access', () =>
      requireChatProject(req.projectId),
    );
    const existingExternalId = project.sharedTemplateExternalId;
    const publicationKey = project.sharedTemplatePublicationKey ?? randomUUID();
    if (
      existingExternalId === undefined &&
      project.sharedTemplatePublicationKey === undefined
    ) {
      await setCoworkWorkspaceTemplatePublicationKey(
        project.id,
        publicationKey,
      );
    }
    let published: Omit<ChatProjectTemplateShareInfo, 'upToDate'>;
    const packageInput = {
      ...(req.audience !== undefined ? { audience: req.audience } : {}),
      ...(req.teamId !== undefined ? { teamId: req.teamId } : {}),
      ...(req.organizationId !== undefined
        ? { organizationId: req.organizationId }
        : {}),
      ...(req.capabilityPackage !== undefined
        ? { capabilityPackage: req.capabilityPackage }
        : {}),
      ...(req.committedPackageUploadId !== undefined
        ? { committedPackageUploadId: req.committedPackageUploadId }
        : {}),
    };
    const hasShareOptions = Object.keys(packageInput).length > 0;
    if (existingExternalId === undefined) {
      published = hasShareOptions
        ? await createWorkspaceTemplateShare(
            document,
            publicationKey,
            packageInput,
          )
        : await createWorkspaceTemplateShare(document, publicationKey);
    } else {
      try {
        published = {
          externalId: existingExternalId,
          sharePath: workspaceTemplateSharePath(existingExternalId),
          ...(hasShareOptions
            ? await republishWorkspaceTemplateShare(
                existingExternalId,
                document,
                packageInput,
              )
            : await republishWorkspaceTemplateShare(
                existingExternalId,
                document,
              )),
        };
      } catch (error) {
        if (!isRemoteNotFound(error)) throw error;
        // A public snapshot is not ownership proof. After an account switch,
        // the old share still resolves anonymously but authenticated republish
        // correctly returns 404. Clear that identity, keep the durable retry
        // key, and publish a current-account share through the idempotent path.
        await clearCoworkWorkspaceTemplateShare(
          project.id,
          'template_share_publish',
        );
        await setCoworkWorkspaceTemplatePublicationKey(
          project.id,
          publicationKey,
        );
        published = hasShareOptions
          ? await createWorkspaceTemplateShare(
              document,
              publicationKey,
              packageInput,
            )
          : await createWorkspaceTemplateShare(document, publicationKey);
      }
    }
    await setCoworkWorkspaceTemplateShareMetadata(project.id, {
      externalId: published.externalId,
      pinnedContentHash: published.pinnedContentHash,
    });
    const summary = (await listWorkspaceTemplateShares()).shares.find(
      (candidate) => candidate.externalId === published.externalId,
    );
    return {
      ...published,
      upToDate: true,
      ...(summary ? { audience: summary.audience, owner: summary.owner } : {}),
    };
  });
}

async function revokeChatProjectTemplateShare(
  req: ChatProjectTemplateShareRevokeRequest,
): Promise<void> {
  return serializeChatProjectOperation(async () => {
    const project = await requireChatProject(req.projectId);
    if (project.sharedTemplateExternalId !== undefined) {
      try {
        await revokeWorkspaceTemplateShare(project.sharedTemplateExternalId);
      } catch (error) {
        if (!isRemoteNotFound(error)) throw error;
      }
    }
    await clearCoworkWorkspaceTemplateShare(
      project.id,
      'template_share_revoke',
    );
  });
}

export function registerChatProjectHandlers(): void {
  registerIpcHandler<[], ChatProjectListResponse>(
    IPC_CHANNELS.chatProjectList,
    async () => serializeChatProjectOperation(listChatProjects),
  );
  registerIpcHandler<[string], void>(
    IPC_CHANNELS.chatProjectEnsureOrgDefaultCowork,
    async (_event, organizationId) => {
      await ensureOrgDefaultCoworkWorkspace(organizationId);
    },
  );
  registerIpcHandler<[string], 'eligible' | 'ineligible'>(
    IPC_CHANNELS.chatProjectGetOrgDefaultCoworkEligibility,
    async (_event, organizationId) =>
      getOrgDefaultCoworkEligibility(organizationId),
  );

  registerIpcHandler<[], DesktopBlueprintCatalogResponse>(
    IPC_CHANNELS.chatProjectBlueprintsList,
    async () => listBlueprints(),
  );

  registerIpcHandler<
    [ListWorkspaceTemplateSharesRequest?],
    ListWorkspaceTemplateSharesResponse
  >(IPC_CHANNELS.chatProjectSharedTemplatesList, async (_event, request) =>
    listWorkspaceTemplateShares(request),
  );

  registerIpcHandler<[], DesktopBlueprintCatalogResponse>(
    IPC_CHANNELS.chatProjectBlueprintsRefresh,
    async () => {
      const blueprints = await refreshBlueprints();
      return {
        blueprints: blueprints ?? [],
        available: blueprints !== null,
      };
    },
  );

  registerIpcHandler<
    [CreateOrgCoworkProjectRequest],
    CreateOrgCoworkProjectResult
  >(IPC_CHANNELS.chatProjectCreateOrgCowork, async (_event, req) => {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (
      !req ||
      typeof req.organizationId !== 'string' ||
      !uuid.test(req.organizationId) ||
      typeof req.name !== 'string' ||
      (req.folderPath !== undefined && typeof req.folderPath !== 'string') ||
      (req.organizationProjectId !== undefined &&
        (typeof req.organizationProjectId !== 'string' ||
          !uuid.test(req.organizationProjectId))) ||
      (req.blueprint !== undefined &&
        (typeof req.blueprint !== 'object' ||
          req.blueprint === null ||
          typeof req.blueprint.externalId !== 'string' ||
          !uuid.test(req.blueprint.externalId) ||
          typeof req.blueprint.contentHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(req.blueprint.contentHash)))
    ) {
      throw new Error('Invalid organization Cowork project request');
    }
    return getOrgCoworkCreator().create(req);
  });

  registerIpcHandler<[CreateChatProjectRequest], CreateChatProjectResponse>(
    IPC_CHANNELS.chatProjectCreate,
    async (_event, req) =>
      serializeChatProjectOperation(() => createChatProject(req.name)),
  );

  registerIpcHandler<
    [CreateChatProjectFromTemplateRequest],
    CreateChatProjectFromTemplateResponse
  >(IPC_CHANNELS.chatProjectCreateFromTemplate, async (_event, req) => {
    if (
      typeof req.sourceTemplate?.externalId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        req.sourceTemplate.externalId,
      ) ||
      typeof req.sourceTemplate.contentHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(req.sourceTemplate.contentHash)
    ) {
      throw new Error('Invalid workspace template source identity');
    }
    const sharedSnapshot =
      req.seed === 'shared'
        ? await getWorkspaceTemplateShareSnapshot(
            req.sourceTemplate.externalId,
            req.sourceTemplate.contentHash,
          )
        : null;
    const parsed = validateSharedWorkspaceTemplateDocument(
      sharedSnapshot?.template ?? req.template,
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const sourceTemplate = sharedSnapshot
      ? {
          externalId: sharedSnapshot.externalId,
          contentHash: sharedSnapshot.contentHash,
          ...(sharedSnapshot.package
            ? { package: sharedSnapshot.package }
            : {}),
          ...(sharedSnapshot.skillPackages
            ? { skillPackages: sharedSnapshot.skillPackages }
            : {}),
        }
      : req.sourceTemplate;
    return serializeChatProjectOperation(async () => {
      if (req.curated === true || req.seed === 'curated') {
        const resolved = await resolveCuratedBlueprintSeed(sourceTemplate);
        const verifiedBlueprint = resolved.blueprint;
        const project = await createCoworkWorkspaceFromBlueprint(
          verifiedBlueprint.document,
          resolved.selections,
          sourceTemplate,
          req.name,
        );
        recordStandaloneProjectCrudTelemetry({
          action: 'create',
          projectId: project.id,
        });
        void reportShareHandoffEvent({
          entity: 'workspace',
          externalId: verifiedBlueprint.externalId,
          eventType: 'INSTALLED',
        });
        return { project, unresolvedRefs: resolved.unresolvedRefs };
      }
      const existingInstall = await findCoworkWorkspaceTemplateInstall(
        sourceTemplate.externalId,
      );
      const hasCapabilityPackages =
        sourceTemplate.package !== undefined ||
        (sourceTemplate.skillPackages?.length ?? 0) > 0;
      if (
        existingInstall?.installedFromTemplateContentHash !== undefined &&
        !hasCapabilityPackages
      ) {
        return { project: existingInstall, unresolvedRefs: [] };
      }
      const resolved = await resolveDesktopWorkspaceTemplate(parsed.document);
      let project = await createCoworkWorkspaceFromTemplate(
        parsed.document,
        resolved.selections,
        sourceTemplate,
        {
          deferInstallCompletion: hasCapabilityPackages,
          ...(req.seed === 'shared' && req.name !== undefined
            ? { name: req.name }
            : {}),
        },
      );
      let unmetPackageRequirements: string[] = [];
      if (hasCapabilityPackages) {
        const installedCapabilities =
          await installDesktopWorkspaceTemplateCapabilityPackages({
            projectId: project.id,
            externalId: sourceTemplate.externalId,
            contentHash: sourceTemplate.contentHash,
            ...(sourceTemplate.package
              ? { package: sourceTemplate.package }
              : {}),
            ...(sourceTemplate.skillPackages
              ? { skillPackages: sourceTemplate.skillPackages }
              : {}),
          });
        const selections = {
          ...resolved.selections,
          skillRefs: Array.from(
            new Map(
              [
                ...resolved.selections.skillRefs,
                ...installedCapabilities.skillRefs,
              ].map((ref) => [`${ref.sourceId}/${ref.skillName}`, ref]),
            ).values(),
          ),
          mcpServerRefs: Array.from(
            new Map(
              [
                ...(resolved.selections.mcpServerRefs ?? []),
                ...installedCapabilities.mcpServerRefs,
              ].map((ref) => [`${ref.serverId}/${ref.configId}`, ref]),
            ).values(),
          ),
        };
        await updateCoworkWorkspace({
          projectId: project.id,
          defaultPluginSelections: selections,
        });
        await setCoworkWorkspaceTemplateInstallMetadata(
          project.id,
          sourceTemplate,
        );
        project = {
          ...project,
          defaultPluginSelections: selections,
          installedFromTemplateContentHash: sourceTemplate.contentHash,
        };
        unmetPackageRequirements = installedCapabilities.unmetRequirements.map(
          (requirement) => requirement.displayName,
        );
      }
      recordStandaloneProjectCrudTelemetry({
        action: 'create',
        projectId: project.id,
      });
      return {
        project,
        unresolvedRefs: [
          ...resolved.unresolvedRefs,
          ...unmetPackageRequirements,
        ],
      };
    });
  });

  registerIpcHandler<
    [ChatProjectTemplateDocumentRequest],
    ChatProjectTemplateDocumentResult
  >(IPC_CHANNELS.chatProjectTemplateBuild, async (_event, req) => {
    return serializeChatProjectOperation(async () => {
      const project = await requireChatProject(req.projectId);
      if (
        typeof req.draft?.name !== 'string' ||
        typeof req.draft.description !== 'string' ||
        (req.draft.color !== undefined &&
          typeof req.draft.color !== 'string') ||
        typeof req.draft.instructions !== 'string' ||
        !isChatTabPluginSelections(req.draft.defaultPluginSelections)
      ) {
        throw new Error('Invalid workspace template draft');
      }
      return buildDesktopWorkspaceTemplateDocument(
        {
          ...project,
          name: req.draft.name,
          description: req.draft.description,
          color: req.draft.color,
          defaultPluginSelections: req.draft.defaultPluginSelections,
        },
        req.draft.instructions,
      );
    });
  });

  registerIpcHandler<
    [ChatProjectTemplateShareRequest],
    ChatProjectTemplateShareInfo | null
  >(IPC_CHANNELS.chatProjectTemplateShareGet, async (_event, req) =>
    getChatProjectTemplateShare(req),
  );

  registerIpcHandler<
    [ChatProjectTemplateShareRequest],
    ShareOperationResult<ChatProjectTemplateShareInfo>
  >(IPC_CHANNELS.chatProjectTemplateSharePublish, (_event, req) =>
    toShareOperationResult(() => publishChatProjectTemplateShare(req)),
  );
  registerIpcHandler<
    [ChatProjectTemplatePackageAnalyzeRequest],
    PipelinePackageAnalysisSummary
  >(IPC_CHANNELS.chatProjectTemplatePackageAnalyze, async (_event, req) => {
    const project = await requireChatProject(req.projectId);
    const document = validatedTemplateShareRequest({
      projectId: req.projectId,
      document: req.document,
    });
    return analyzeSubjectCapabilityPackage({
      rawContent: serializeSharedWorkspaceTemplateForHash(document),
      scopeKey: `blueprint:${project.id}`,
      selections: project.defaultPluginSelections ?? {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      promptTexts: [
        document.instructions,
        ...(document.starterPrompts ?? []).map((prompt) => prompt.text),
      ],
      environmentRequirements: workspaceTemplateModelRequirements(
        project.defaultModel,
      ),
      dismissedInvocations: req.dismissedInvocations,
    });
  });
  registerIpcHandler(
    IPC_CHANNELS.chatProjectTemplatePackageCancelAnalysis,
    (_event, analysisId: string) => cancelPackageAnalysis(analysisId),
  );
  registerIpcHandler(
    IPC_CHANNELS.chatProjectTemplatePackageCommit,
    (_event, req: ChatProjectTemplatePackageCommitRequest) =>
      toShareOperationResult(
        () => createSubjectCapabilityPackage(req),
        'prepare',
      ),
  );
  registerIpcHandler<
    [ChatProjectTemplatePackageReadinessRequest],
    PipelinePackageReadiness
  >(IPC_CHANNELS.chatProjectTemplatePackageReadiness, async (_event, req) => {
    if (!Array.isArray(req.packages) || req.packages.length > 26) {
      throw new Error(
        `Invalid ${WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER} capability package review`,
      );
    }
    const requirements = Array.from(
      new Map(
        req.packages
          .flatMap((item) => item.environmentRequirements)
          .map((requirement) => [
            `${requirement.kind}:${requirement.id}`,
            requirement,
          ]),
      ).values(),
    );
    if (requirements.length > 250) {
      throw new Error(
        `${WORKSPACE_TEMPLATE_SHARE_LABEL} capability package review is too large`,
      );
    }
    return {
      ...(await evaluatePipelinePackageRequirements(
        requirements,
        probePipelinePackageRequirement,
      )),
      distributionMode: 'package',
    };
  });

  registerIpcHandler<[ChatProjectTemplateShareRevokeRequest], void>(
    IPC_CHANNELS.chatProjectTemplateShareRevoke,
    async (_event, req) => revokeChatProjectTemplateShare(req),
  );

  registerIpcHandler<[UpdateChatProjectRequest], void>(
    IPC_CHANNELS.chatProjectUpdate,
    async (_event, req) => {
      await serializeChatProjectOperation(() => updateChatProject(req));
    },
  );

  registerIpcHandler<[DeleteChatProjectRequest], void>(
    IPC_CHANNELS.chatProjectDelete,
    async (_event, req) => {
      await serializeChatProjectOperation(() => deleteChatProject(req));
    },
  );

  registerIpcHandler<[ChatProjectClaudeMdRequest], string>(
    IPC_CHANNELS.chatProjectLoadClaudeMd,
    async (_event, req) =>
      serializeChatProjectOperation(() =>
        loadChatProjectClaudeMd(req.projectId),
      ),
  );

  registerIpcHandler<[SaveChatProjectClaudeMdRequest], void>(
    IPC_CHANNELS.chatProjectSaveClaudeMd,
    async (_event, req) => {
      await serializeChatProjectOperation(() => saveChatProjectClaudeMd(req));
    },
  );
}
