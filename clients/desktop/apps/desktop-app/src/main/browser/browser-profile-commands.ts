import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  readProfileJson,
  writeProfileJson,
  withProfileWriter,
} from '@canopy/desktop-shared/node/browser-profiles/storage';
import {
  isBrowserTaskScope,
  isProfileId,
  isProfileRecord,
  browserTaskScopeTuple,
  type BrowserProfilesApi,
  type BrowserProfileDeletePreview,
  type BrowserProfileUsage,
} from '@canopy/protocol/browser-profiles';
import { getBrowserProfileService } from './browser-profile-service';
import type { BrowserService } from './browser-service';

const fingerprint = (usage: BrowserProfileUsage): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        tabs: usage.tabs,
        defaults: usage.defaults.map(browserTaskScopeTuple).sort(),
      }),
    )
    .digest('hex');

function isUsageTab(
  value: unknown,
): value is BrowserProfileUsage['tabs'][number] {
  return (
    isProfileRecord(value) &&
    isProfileId(value.browserId) &&
    isProfileId(value.projectId) &&
    isProfileId(value.worktreeId) &&
    Number.isSafeInteger(value.runtimeGeneration) &&
    Number(value.runtimeGeneration) >= 1 &&
    (value.taskIncarnationId === undefined ||
      isProfileId(value.taskIncarnationId))
  );
}

/** Trusted app renderer configuration; this object is never exposed to embedded pages or agent dispatch. */
export function createBrowserProfileCommands(
  browser: BrowserService,
): BrowserProfilesApi {
  const recordPath = (kind: 'preview' | 'delete', id: string): string => {
    if (!isProfileId(id))
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid profile operation ID.',
      );
    return join(
      getBrowserProfileService().dataRoot,
      'browser-profile-commands',
      kind,
      `${id}.json`,
    );
  };
  const readPreview = async (
    token: string,
  ): Promise<BrowserProfileDeletePreview> => {
    const value = await readProfileJson(recordPath('preview', token));
    if (
      isProfileRecord(value) &&
      value.schemaVersion === 1 &&
      value.expired === true &&
      value.token === token
    )
      throw new BrowserProfileError(
        'operation_expired',
        'This deletion preview expired. Request a new preview.',
      );

    if (
      !isProfileRecord(value) ||
      value.schemaVersion !== 1 ||
      !isProfileRecord(value.preview) ||
      value.preview.token !== token ||
      !isProfileId(value.preview.profileId) ||
      !Number.isSafeInteger(value.preview.expiresAt) ||
      !Number.isSafeInteger(value.preview.metadataRevision) ||
      !Number.isSafeInteger(value.preview.storageGeneration) ||
      !Array.isArray(value.preview.tabs) ||
      !value.preview.tabs.every(isUsageTab) ||
      !Array.isArray(value.preview.defaults) ||
      !value.preview.defaults.every(isBrowserTaskScope)
    )
      throw new BrowserProfileError(
        'recovery_required',
        'The deletion preview is unavailable. Request a new preview.',
      );
    if (Date.now() - Number(value.preview.expiresAt) > 7 * 86400_000) {
      await writeProfileJson(recordPath('preview', token), {
        schemaVersion: 1,
        expired: true,
        token,
      });
      throw new BrowserProfileError(
        'operation_expired',
        'This deletion preview expired. Request a new preview.',
      );
    }
    return {
      token,
      profileId: value.preview.profileId,
      storageGeneration: Number(value.preview.storageGeneration),
      metadataRevision: Number(value.preview.metadataRevision),
      expiresAt: Number(value.preview.expiresAt),
      tabs: value.preview.tabs,
      defaults: value.preview.defaults,
    };
  };
  return {
    inventoryStart: (request) =>
      browser.profileData.userCommands().inventoryStart(request),
    inventoryGet: (request) =>
      browser.profileData.userCommands().inventoryGet(request),
    jobGet: (request) => browser.profileData.userCommands().jobGet(request),
    jobList: (request) => browser.profileData.userCommands().jobList(request),
    jobCancel: (request) =>
      browser.profileData.userCommands().jobCancel(request),
    previewClear: (request) =>
      browser.profileData.userCommands().previewClear(request),
    clear: (request) => browser.profileData.userCommands().clear(request),
    retryJob: (request) => browser.profileData.userCommands().retryJob(request),
    cleanupStatus: () => browser.profileData.userCommands().cleanupStatus(),
    retryCleanup: () => browser.profileData.userCommands().retryCleanup(),
    async list(
      request = {},
    ): Promise<Awaited<ReturnType<BrowserProfilesApi['list']>>> {
      const service = getBrowserProfileService();
      const scope =
        request.projectId && request.worktreeId
          ? (await service.taskContext(request.projectId, request.worktreeId))
              .scope
          : undefined;
      if (!!request.projectId !== !!request.worktreeId)
        throw new BrowserProfileError(
          'invalid_request',
          'Supply both task identifiers.',
        );
      return service.listProfiles(request.offset, scope);
    },
    async get({
      profileId,
    }): Promise<Awaited<ReturnType<BrowserProfilesApi['get']>>> {
      const service = getBrowserProfileService();
      await service.ensureReady();
      return service.repository.get(profileId);
    },
    async create({
      operationId,
      input,
    }): Promise<Awaited<ReturnType<BrowserProfilesApi['create']>>> {
      const service = getBrowserProfileService();
      await service.ensureReady();
      return service.repository.createNamed(operationId, input);
    },
    async update({
      operationId,
      profileId,
      expectedMetadataRevision,
      patch,
    }): Promise<Awaited<ReturnType<BrowserProfilesApi['update']>>> {
      const service = getBrowserProfileService();
      await service.ensureReady();
      const profile = await service.repository.updateProfile(
        operationId,
        profileId,
        expectedMetadataRevision,
        patch,
      );
      await browser.refreshProfileMetadata(profile);
      return profile;
    },
    async context({
      projectId,
      worktreeId,
    }): Promise<Awaited<ReturnType<BrowserProfilesApi['context']>>> {
      return getBrowserProfileService().taskContext(projectId, worktreeId);
    },
    async setDefault({
      operationId,
      projectId,
      worktreeId,
      incarnationId,
      expectedMetadataRevision,
      selection,
    }): Promise<Awaited<ReturnType<BrowserProfilesApi['setDefault']>>> {
      const service = getBrowserProfileService();
      const slot = await service.taskContext(projectId, worktreeId);
      if (selection.kind === 'named')
        browser.assertProfileAvailable(selection.profileId);
      return service.repository.setDefault(
        operationId,
        slot.scope,
        incarnationId,
        expectedMetadataRevision,
        selection,
      );
    },
    async previewDelete({
      profileId,
      expectedMetadataRevision,
    }): Promise<Awaited<ReturnType<BrowserProfilesApi['previewDelete']>>> {
      const service = getBrowserProfileService();
      await service.ensureReady();
      const profile = await service.repository.get(profileId);
      if (profile.kind !== 'named')
        throw new BrowserProfileError(
          'invalid_request',
          'Task profiles retire with their task.',
        );
      if (profile.metadataRevision !== expectedMetadataRevision)
        throw new BrowserProfileError(
          'stale_revision',
          'Profile settings changed. Refresh before deleting.',
        );
      const usage = await browser.profileUsage(profileId);
      const preview: BrowserProfileDeletePreview = {
        ...usage,
        token: randomUUID(),
        profileId,
        metadataRevision: profile.metadataRevision,
        storageGeneration: profile.storageGeneration,
        expiresAt: Date.now() + 300_000,
      };
      await writeProfileJson(recordPath('preview', preview.token), {
        schemaVersion: 1,
        preview,
      });
      return preview;
    },
    async delete({
      operationId,
      token,
    }): Promise<Awaited<ReturnType<BrowserProfilesApi['delete']>>> {
      const path = recordPath('delete', operationId);
      // A durable intent links the operation ID to its exact preview, including
      // retries after catalog retirement but before the final response is saved.
      return withProfileWriter(`${path}.lock-dir`, async () => {
        const saved = await readProfileJson(path);
        if (saved !== undefined) {
          if (
            !isProfileRecord(saved) ||
            saved.schemaVersion !== 1 ||
            !Number.isSafeInteger(saved.createdAt)
          )
            throw new BrowserProfileError(
              'recovery_required',
              'The deletion operation needs recovery. Original data was preserved.',
            );
          if (saved.token !== token)
            throw new BrowserProfileError(
              'operation_conflict',
              'This deletion operation ID has different input.',
            );
          if (
            saved.expired === true ||
            Date.now() - Number(saved.createdAt) > 7 * 86400_000
          ) {
            if (saved.expired !== true)
              await writeProfileJson(path, {
                schemaVersion: 1,
                expired: true,
                token,
                createdAt: saved.createdAt,
              });
            throw new BrowserProfileError(
              'operation_expired',
              'This deletion result expired. Refresh profiles.',
            );
          }
          if (
            isProfileRecord(saved.result) &&
            typeof saved.result.cleanupPending === 'boolean'
          )
            return { cleanupPending: saved.result.cleanupPending };
        }
        const preview = await readPreview(token);
        const service = getBrowserProfileService();
        await service.ensureReady();
        return browser.withProfileFence(preview.profileId, async () => {
          let alreadyDeleted = false;
          try {
            const profile = await service.repository.get(preview.profileId);
            if (
              preview.expiresAt < Date.now() ||
              profile.metadataRevision !== preview.metadataRevision ||
              profile.storageGeneration !== preview.storageGeneration ||
              fingerprint(await browser.profileUsage(preview.profileId)) !==
                fingerprint(preview)
            )
              throw new BrowserProfileError(
                'stale_revision',
                'Profile settings, affected tabs, or preview validity changed. Request a new preview.',
              );
          } catch (cause) {
            if (
              !(cause instanceof BrowserProfileError) ||
              cause.code !== 'profile_unavailable' ||
              saved === undefined
            )
              throw cause;
            // Only the repository's matching durable receipt can authorize this
            // replay. A deletion performed by another operation still rejects.
            await service.repository.deleteNamed(
              operationId,
              preview.profileId,
              preview.metadataRevision,
            );
            alreadyDeleted = true;
          }
          const intent = saved ?? {
            schemaVersion: 1,
            token,
            createdAt: Date.now(),
          };
          if (saved === undefined) await writeProfileJson(path, intent);
          if (!alreadyDeleted) {
            await browser.disposeProfileViews(preview.profileId);
            await service.repository.deleteNamed(
              operationId,
              preview.profileId,
              preview.metadataRevision,
            );
          }
          await browser.markProfileUnavailable(preview.profileId);
          await service.purgeRetired();
          const result = {
            cleanupPending: (await service.repository.getCleanupJobs()).some(
              (job) => job.profileId === preview.profileId,
            ),
          };
          await writeProfileJson(path, { ...intent, result });
          return result;
        });
      });
    },
  };
}
