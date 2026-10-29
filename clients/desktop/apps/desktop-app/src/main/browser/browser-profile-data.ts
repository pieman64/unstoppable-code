import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webContents, type Session } from 'electron';
import {
  isProfileRecord,
  type BrowserClearPreview,
  type BrowserDataActor,
  type BrowserDataJob,
  type BrowserProfileDataApi,
  type BrowserProfileRecord,
  type BrowserMaintenanceOperation,
} from '@canopy/protocol/browser-profiles';
import { BrowserDataJobs } from '@canopy/desktop-shared/node/browser-profiles/data-jobs';
import { BrowserObservedSites } from '@canopy/desktop-shared/node/browser-profiles/observed-sites';
import {
  BrowserOwnedScratch,
  type BrowserScratchOwner,
} from '@canopy/desktop-shared/node/browser-profiles/owned-scratch';
import { BrowserProfileInventoryService } from '@canopy/desktop-shared/node/browser-profiles/inventory-service';
import {
  BrowserMaintenanceCoordinator,
  type BrowserMaintenanceAdapter,
} from '@canopy/desktop-shared/node/browser-profiles/maintenance-coordinator';
import type { BrowserProfileMaintenanceBinding } from '@canopy/desktop-shared/node/browser-profiles/repository';
import {
  resolveBrowserTaskOwner,
  browserTaskOwnerIds,
} from '@canopy/desktop-shared/node/browser-profiles/owners';
import { browserInventoryQueue } from './inventory-runtime';
import {
  BrowserNativeMaintenance,
  SITE_DATA_TYPES,
  verificationOrigin,
} from './native-maintenance';
import { getBrowserProfileService } from './browser-profile-service';
import type { BrowserService } from './browser-service';

const USER: BrowserDataActor = { kind: 'user' };
const canonicalDomain = (domain: string): string =>
  domain.replace(/^\./, '').toLowerCase();
const inDomain = (value: string, domain: string): boolean => {
  const host = canonicalDomain(value);
  return host === domain || host.endsWith(`.${domain}`);
};

/** One app-owned composition root. No caller can inject an actor or native locator. */
export class BrowserProfileData {
  private readonly profiles = getBrowserProfileService();
  readonly jobs = new BrowserDataJobs(
    join(this.profiles.dataRoot, 'browser-data-jobs'),
  );
  readonly observations = new BrowserObservedSites(
    join(this.profiles.dataRoot, 'browser-observed-sites'),
    (id, generation, action) =>
      this.profiles.repository.withActiveGeneration(id, generation, action),
  );
  readonly scratch: BrowserOwnedScratch;
  readonly inventory: BrowserProfileInventoryService;
  readonly maintenance: BrowserMaintenanceCoordinator;
  private initialization?: Promise<void>;
  private recoveringScratch = false;
  private readonly controls = new Map<string, BrowserNativeMaintenance>();
  private readonly natives = new Map<string, Session>();
  private readonly resumeTabs = new Map<
    string,
    ReturnType<BrowserService['captureProfileViews']>
  >();

  constructor(private readonly browser: BrowserService) {
    this.browser.downloads.attachJobs(this.jobs);
    this.browser.downloads.setResumeAuthority(async (owner, resume) => {
      const ids = browserTaskOwnerIds(owner.taskScope);
      if (
        !(await resolveBrowserTaskOwner(
          this.profiles.dataRoot,
          ids.projectId,
          ids.worktreeId,
        ))
      )
        throw new BrowserProfileError(
          'scope_retired',
          'The download owner is no longer active.',
        );
      await this.profiles.repository.withActiveBinding(
        {
          profileId: owner.profileId,
          storageGeneration: owner.storageGeneration,
          scope: owner.taskScope,
          incarnationId: owner.taskIncarnationId,
        },
        () => {
          this.browser.assertProfileAvailable(owner.profileId);
          resume();
          return Promise.resolve();
        },
      );
    });
    this.profiles.setCleanupPreparation(async (job) => {
      await this.inventory.cancelProfile(job.profileId, job.storageGeneration);
      this.browser.downloads.cancelProfile(
        job.profileId,
        job.storageGeneration,
      );
      await this.browser.downloads.drain();
      await this.scratch.cleanup(
        (owner) =>
          owner.profileId === job.profileId &&
          owner.storageGeneration === job.storageGeneration,
      );
    });
    this.scratch = new BrowserOwnedScratch(
      join(this.profiles.dataRoot, 'browser-owned-scratch'),
      {
        withOwner: <T>(
          owner: BrowserScratchOwner,
          commit: () => Promise<T>,
        ): Promise<T> => this.withScratchOwner(owner, commit),
      },
    );
    this.inventory = new BrowserProfileInventoryService(
      join(this.profiles.dataRoot, 'browser-inventory'),
      {
        withGeneration: <T>(
          id: string,
          generation: number,
          action: () => Promise<T>,
        ): Promise<T> =>
          this.profiles.repository.withActiveGeneration(id, generation, action),
        directory: (id, generation): Promise<string> =>
          this.profiles.storageDirectory(id, generation),
        assertAvailable: (id): void => this.browser.assertProfileAvailable(id),
        cookies: async (
          id,
          generation,
        ): Promise<{
          domains: { domain: string; count: number }[];
          measured: boolean;
          truncated: boolean;
        }> => {
          const native = await this.profiles.existingSession(id, generation);
          const counts = new Map<string, number>();
          for (const cookie of native ? await native.cookies.get({}) : [])
            if (cookie.domain)
              counts.set(cookie.domain, (counts.get(cookie.domain) ?? 0) + 1);
          return {
            domains: Array.from(counts, ([domain, count]) => ({
              domain,
              count,
            })),
            measured: true,
            truncated: counts.size > 1000,
          };
        },
      },
      browserInventoryQueue,
      this.observations,
      this.jobs,
    );
    this.maintenance = new BrowserMaintenanceCoordinator(
      join(this.profiles.dataRoot, 'browser-maintenance'),
      this.jobs,
      {
        retirement: (
          preview,
        ): Promise<{ retired: boolean; cleanupPending: boolean }> =>
          this.profiles.repository.retirementStatus(
            preview.profileId,
            preview.storageGeneration,
          ),
        profile: (id): ReturnType<BrowserMaintenanceAdapter['profile']> =>
          this.profiles.repository.get(id),
        authorize: (
          profile,
          actor,
        ): ReturnType<BrowserMaintenanceAdapter['authorize']> =>
          this.authorize(profile, actor),
        usage: (id): ReturnType<BrowserMaintenanceAdapter['usage']> =>
          this.browser.profileUsage(id),
        scope: (
          profile,
          operation,
        ): ReturnType<BrowserMaintenanceAdapter['scope']> =>
          this.scope(profile, operation),
        fence: (id): ReturnType<BrowserMaintenanceAdapter['fence']> =>
          this.browser.setMaintenanceFence(id, true),
        unfence: (id): ReturnType<BrowserMaintenanceAdapter['fence']> =>
          this.browser.setMaintenanceFence(id, false),
        drainCreations: (
          id,
        ): ReturnType<BrowserMaintenanceAdapter['drainCreations']> =>
          this.browser.drainProfileCreations(id),
        quiesce: (preview): ReturnType<BrowserMaintenanceAdapter['quiesce']> =>
          this.quiesce(preview),
        verifySupported: (
          preview,
        ): ReturnType<BrowserMaintenanceAdapter['verifySupported']> =>
          this.verifySupported(preview),
        invoke: (
          preview,
          actor,
          id,
          journal,
        ): ReturnType<BrowserMaintenanceAdapter['invoke']> =>
          this.invoke(preview, actor, id, journal),
        recover: (
          preview,
          id,
        ): ReturnType<BrowserMaintenanceAdapter['recover']> =>
          this.recoverClear(preview, id),
        verifyCleared: (
          preview,
        ): ReturnType<BrowserMaintenanceAdapter['verifyCleared']> =>
          this.verifyCleared(preview),
        rebind: (
          preview,
          generation,
        ): ReturnType<BrowserMaintenanceAdapter['rebind']> =>
          this.browser.rebindProfileViews(preview, generation),
        release: (preview): ReturnType<BrowserMaintenanceAdapter['release']> =>
          this.release(preview),
        resume: (preview): ReturnType<BrowserMaintenanceAdapter['resume']> =>
          this.resume(preview),
      },
    );
  }

  ensureReady(): Promise<void> {
    this.initialization ??= (async (): Promise<void> => {
      await this.profiles.ensureReady();
      await this.jobs.compact();
      await this.inventory.recover();
      await this.browser.downloads.recover();
      this.recoveringScratch = true;
      try {
        await this.scratch.recover();
      } finally {
        this.recoveringScratch = false;
      }
      // Fences are installed before any browser admission, including cold tabs.
      await this.maintenance.recover();
    })().catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  async shutdown(): Promise<void> {
    await this.maintenance.shutdown();
    await this.inventory.shutdown();
    await browserInventoryQueue.shutdown();
    await this.observations.close();
    await this.browser.downloads.shutdown();
    await this.scratch.drain(() => true);
    for (const control of Array.from(this.controls.values()))
      await control.release();
    this.controls.clear();
  }

  private async withScratchOwner<T>(
    owner: BrowserScratchOwner,
    commit: () => Promise<T>,
  ): Promise<T> {
    const snapshot = await this.browser.scratchOwnerSnapshot(
      owner,
      this.recoveringScratch,
    );
    if (!snapshot)
      throw new BrowserProfileError(
        'stale_runtime',
        'The browser temporary-data owner changed.',
      );
    return this.profiles.repository.withActiveBinding(
      {
        profileId: owner.profileId,
        storageGeneration: owner.storageGeneration,
        scope: owner.taskScope,
        incarnationId: owner.taskIncarnationId,
      },
      async () => {
        this.browser.assertProfileAvailable(owner.profileId);
        if (!this.recoveringScratch && !this.browser.matchesScratchOwner(owner))
          throw new BrowserProfileError(
            'stale_runtime',
            'The browser temporary-data owner changed.',
          );
        return commit();
      },
    );
  }

  private binding(
    preview: Pick<
      BrowserClearPreview,
      'profileId' | 'storageGeneration' | 'metadataRevision'
    >,
    actor: BrowserDataActor,
  ): BrowserProfileMaintenanceBinding {
    return {
      profileId: preview.profileId,
      storageGeneration: preview.storageGeneration,
      metadataRevision: preview.metadataRevision,
      ...(actor.kind === 'agent'
        ? {
            actor: {
              kind: 'agent' as const,
              scope: actor.taskScope,
              incarnationId: actor.taskIncarnationId,
            },
          }
        : {}),
    };
  }
  private async authorize(
    profile: BrowserProfileRecord,
    actor: BrowserDataActor,
  ): Promise<void> {
    if (actor.kind === 'agent') {
      const ids = browserTaskOwnerIds(actor.taskScope);
      const owner = await resolveBrowserTaskOwner(
        this.profiles.dataRoot,
        ids.projectId,
        ids.worktreeId,
      );
      const slot = await this.profiles.repository.getTask(actor.taskScope);
      if (
        !owner ||
        !slot ||
        slot.lifecycle !== 'active' ||
        owner.createdAt !== slot.ownerCreatedAt ||
        slot.incarnationId !== actor.taskIncarnationId
      )
        throw new BrowserProfileError(
          'scope_retired',
          'The originating task is unavailable.',
        );
    }
    await this.profiles.repository.withActiveProfile(
      this.binding(
        {
          profileId: profile.profileId,
          storageGeneration: profile.storageGeneration,
          metadataRevision: profile.metadataRevision,
        },
        actor,
      ),
      async () => {},
    );
  }

  private async scope(
    profile: BrowserProfileRecord,
    operation: BrowserMaintenanceOperation,
  ): Promise<
    Pick<BrowserClearPreview, 'dataClasses' | 'cookieDomains' | 'contexts'>
  > {
    if (
      !isProfileRecord(operation) ||
      !['cache', 'site', 'reset'].includes(operation.kind)
    )
      throw new BrowserProfileError(
        'invalid_request',
        'Choose cache, site data, or whole-profile reset.',
      );
    if (operation.kind === 'cache')
      return { dataClasses: ['httpCache'], cookieDomains: [], contexts: [] };
    if (operation.kind === 'reset')
      return {
        dataClasses: ['allSiteData', 'httpCache', 'browserScratch'],
        cookieDomains: [],
        contexts: [],
      };
    const origin = verificationOrigin(operation.origin);
    const observations = await this.observations.read(
      profile.profileId,
      profile.storageGeneration,
    );
    const sites = observations.sites.filter((site) => site.origin === origin);
    const domains = new Set(sites.map((site) => site.cookieDomain));
    if (
      observations.truncated ||
      !sites.length ||
      domains.size !== 1 ||
      domains.has(null)
    )
      throw new BrowserProfileError(
        'unsupported_scope',
        'This site has incomplete storage-context information. Choose a whole-profile reset.',
      );
    for (const site of sites) verificationOrigin(site.topLevelOrigin);
    const domain = sites[0].cookieDomain;
    if (domain === null)
      throw new BrowserProfileError(
        'unsupported_scope',
        'The cookie scope is unavailable. Choose a whole-profile reset.',
      );
    const native = await this.profiles.existingSession(
      profile.profileId,
      profile.storageGeneration,
    );
    const affected = new Set<string>();
    for (const cookie of native ? await native.cookies.get({}) : [])
      if (cookie.domain && inDomain(cookie.domain, domain))
        affected.add(cookie.domain);
    return {
      dataClasses: [...SITE_DATA_TYPES],
      cookieDomains: Array.from(affected).sort(),
      contexts: Array.from(
        new Map(
          [
            ...sites.map((site) => ({
              origin,
              topLevelOrigin: site.topLevelOrigin,
            })),
            { origin, topLevelOrigin: origin },
          ].map((context) => [JSON.stringify(context), context]),
        ).values(),
      ),
    };
  }

  private async quiesce(preview: BrowserClearPreview): Promise<void> {
    if (!this.resumeTabs.has(preview.profileId))
      this.resumeTabs.set(
        preview.profileId,
        this.browser.captureProfileViews(preview.profileId),
      );
    await this.inventory.cancelProfile(preview.profileId);
    // Reset replay may already have advanced the catalog; retire the exact old store separately.
    const current = await this.profiles.repository.get(preview.profileId);
    const native =
      current.storageGeneration === preview.storageGeneration
        ? await this.profiles.existingSession(
            preview.profileId,
            preview.storageGeneration,
          )
        : undefined;
    if (native) {
      this.natives.set(preview.profileId, native);
      this.profiles.networkPolicy(native).fence();
    }
    await this.browser.disposeProfileViews(preview.profileId);
    await this.browser.downloads.drain();
    await this.scratch.drain(
      (owner) =>
        owner.profileId === preview.profileId &&
        owner.storageGeneration === preview.storageGeneration,
    );
    if (!native) return;
    // Disposal's service promise does not itself prove native renderer termination.
    const remaining = webContents
      .getAllWebContents()
      .filter((contents) => contents.session === native);
    for (const contents of remaining)
      if (!contents.isDestroyed())
        contents.close({ waitForBeforeUnload: false });
    const deadline = Date.now() + 15000;
    while (remaining.some((contents) => !contents.isDestroyed())) {
      if (Date.now() >= deadline)
        throw new BrowserProfileError(
          'unsupported_scope',
          'Browser pages could not be stopped. Stored site data was not changed.',
        );
      await delay(20);
    }
    const previous = this.controls.get(preview.profileId);
    if (previous) await previous.release();
    const control = new BrowserNativeMaintenance(
      native,
      this.profiles.networkPolicy(native),
    );
    this.controls.set(preview.profileId, control);
    await control.stopWorkers();
  }

  private async verifySupported(preview: BrowserClearPreview): Promise<void> {
    const operation = preview.operation;
    if (operation.kind !== 'site') return;
    const control = this.controls.get(preview.profileId);
    if (!control) return; // No native directory existed; there are no stores to mutate.
    const observations = await this.observations.read(
      preview.profileId,
      preview.storageGeneration,
    );
    const expected = observations.sites.find(
      (site) => site.origin === operation.origin,
    )?.cookieDomain;
    for (const context of preview.contexts) {
      const actual = await control.inspect(
        context.origin,
        context.topLevelOrigin,
      );
      const domain =
        actual.registrableDomain || new URL(actual.origin).hostname;
      if (domain !== expected)
        throw new BrowserProfileError(
          'unsupported_scope',
          'The browser cookie scope changed. Request a new preview.',
        );
    }
  }

  private async invoke(
    preview: BrowserClearPreview,
    actor: BrowserDataActor,
    id: string,
    journal: () => Promise<void>,
  ): Promise<{
    completion: Promise<{ storageGeneration: number; cleanupPending: boolean }>;
  }> {
    await this.authorize(
      await this.profiles.repository.get(preview.profileId),
      actor,
    );
    if (preview.operation.kind === 'reset') {
      const result = await this.profiles.repository.resetProfile(
        id,
        this.binding(preview, actor),
        { beforeCommit: journal },
      );
      await this.scratch.cleanup(
        (owner) =>
          owner.profileId === preview.profileId &&
          owner.storageGeneration === preview.storageGeneration,
      );
      return {
        completion: Promise.resolve({
          storageGeneration: result.profile.storageGeneration,
          cleanupPending: true,
        }),
      };
    }
    return this.profiles.repository.withActiveProfile(
      this.binding(preview, actor),
      async () => {
        await journal();
        return { completion: this.clearNative(preview) };
      },
    );
  }
  private async clearNative(
    preview: BrowserClearPreview,
  ): Promise<{ storageGeneration: number; cleanupPending: boolean }> {
    const native = this.natives.get(preview.profileId);
    if (native) {
      if (preview.operation.kind === 'cache') await native.clearCache();
      else if (preview.operation.kind === 'site')
        await native.clearData({
          origins: [verificationOrigin(preview.operation.origin)],
          originMatchingMode: 'origin-in-all-contexts',
          dataTypes: SITE_DATA_TYPES,
        });
    }
    return {
      storageGeneration: preview.storageGeneration,
      cleanupPending: false,
    };
  }
  private async recoverClear(
    preview: BrowserClearPreview,
    id: string,
  ): Promise<{ storageGeneration: number; cleanupPending: boolean }> {
    if (preview.operation.kind === 'reset') {
      const record = await this.jobs.getForExecution(id);
      if (!record?.irreversible)
        throw new BrowserProfileError(
          'recovery_required',
          'The reset authorization is unavailable.',
        );
      const result = await this.profiles.repository.resetProfile(
        id,
        this.binding(preview, record.actor),
        { authorizedRecovery: true },
      );
      await this.scratch.cleanup(
        (owner) =>
          owner.profileId === preview.profileId &&
          owner.storageGeneration === preview.storageGeneration,
      );
      return {
        storageGeneration: result.profile.storageGeneration,
        cleanupPending: true,
      };
    }
    await this.profiles.repository.withActiveGeneration(
      preview.profileId,
      preview.storageGeneration,
      async () => {},
    );
    await this.verifySupported(preview);
    return this.clearNative(preview);
  }
  private async verifyCleared(preview: BrowserClearPreview): Promise<void> {
    await this.controls.get(preview.profileId)?.verifyEmpty(preview.contexts);
    const native = this.natives.get(preview.profileId);
    if (!native) return;
    const affected = new Set(preview.cookieDomains.map(canonicalDomain));
    if (
      (await native.cookies.get({})).some(
        (cookie) =>
          cookie.domain && affected.has(canonicalDomain(cookie.domain)),
      )
    )
      throw new BrowserProfileError(
        'recovery_required',
        'Cookie cleanup could not be verified. This profile remains paused.',
      );
  }
  private async release(preview: BrowserClearPreview): Promise<void> {
    const control = this.controls.get(preview.profileId);
    if (control) await control.release();
    this.controls.delete(preview.profileId);
    if (
      (
        await this.profiles.repository.retirementStatus(
          preview.profileId,
          preview.storageGeneration,
        )
      ).retired
    ) {
      this.natives.delete(preview.profileId);
      this.resumeTabs.delete(preview.profileId);
      void this.profiles.purgeRetired().catch(() => undefined);
    }
  }
  private async resume(preview: BrowserClearPreview): Promise<void> {
    const native = this.natives.get(preview.profileId);
    if (
      (
        await this.profiles.repository.retirementStatus(
          preview.profileId,
          preview.storageGeneration,
        )
      ).retired
    ) {
      this.natives.delete(preview.profileId);
      this.resumeTabs.delete(preview.profileId);
      return;
    }
    const current = await this.profiles.repository.get(preview.profileId);
    if (native && current.storageGeneration === preview.storageGeneration)
      this.profiles.networkPolicy(native).resume();
    this.natives.delete(preview.profileId);
    const tabs = this.resumeTabs.get(preview.profileId) ?? [];
    this.resumeTabs.delete(preview.profileId);
    await this.browser.resumeProfileViews(tabs);
    void this.profiles.purgeRetired().catch(() => undefined);
  }

  userCommands(): BrowserProfileDataApi {
    const ready = async <T>(action: () => Promise<T>): Promise<T> => {
      await this.ensureReady();
      return action();
    };
    return {
      inventoryStart: (request) =>
        ready(() =>
          this.inventory.start(
            request.operationId,
            request.profileId,
            request.storageGeneration,
          ),
        ),
      inventoryGet: (request) =>
        ready(() =>
          this.inventory.get(
            request.profileId,
            request.storageGeneration,
            request.offset,
          ),
        ),
      jobGet: (request) => ready(() => this.jobs.get(request.jobId, USER)),
      jobList: (request) =>
        ready(() => this.jobs.list(USER, request?.offset, request?.profileId)),
      jobCancel: (request) =>
        ready(async (): Promise<BrowserDataJob> => {
          const job = await this.jobs.cancel(request.jobId, USER);
          await this.inventory.cancelJob(job.jobId);
          this.browser.downloads.cancelJob(job.jobId);
          return job;
        }),
      previewClear: (request) =>
        ready(() =>
          this.maintenance.preview(
            USER,
            request.profileId,
            request.storageGeneration,
            request.metadataRevision,
            request.operation,
          ),
        ),
      clear: (request) =>
        ready(() =>
          this.maintenance.commit(USER, request.operationId, request.token),
        ),
      retryJob: (request) => ready(() => this.maintenance.retry(request.jobId)),
      cleanupStatus: () =>
        ready(async () => ({
          jobs: (await this.profiles.repository.getCleanupJobs()).map(
            (job) => ({
              jobId: job.jobId,
              profileId: job.profileId,
              storageGeneration: job.storageGeneration,
              status: this.profiles.cleanupErrors.has(job.jobId)
                ? ('failed' as const)
                : this.profiles.isCleanupLoaded(job.partition)
                  ? ('pending_restart' as const)
                  : ('pending' as const),
              ...(this.profiles.cleanupErrors.has(job.jobId)
                ? { message: this.profiles.cleanupErrors.get(job.jobId) }
                : {}),
            }),
          ),
        })),
      retryCleanup: () =>
        ready(async (): Promise<{ remaining: number }> => {
          await this.profiles.purgeRetired();
          return {
            remaining: (await this.profiles.repository.getCleanupJobs()).length,
          };
        }),
    };
  }
}
