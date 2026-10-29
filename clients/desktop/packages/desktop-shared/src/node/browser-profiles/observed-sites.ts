import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import { join } from 'node:path';
import { isIP } from 'node:net';
import {
  isProfileId,
  isProfileRecord,
} from '@canopy/protocol/browser-profiles';
import {
  readProfileJson,
  withProfileWriter,
  writeProfileJson,
} from './storage';
import type { BrowserObservedSite } from '@canopy/protocol/browser-profiles';

interface Observations {
  schemaVersion: 1;
  profileId: string;
  storageGeneration: number;
  sites: BrowserObservedSite[];
  truncated: boolean;
}
export function browserOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}
function origin(value: unknown): value is string {
  return typeof value === 'string' && browserOrigin(value) === value;
}
const siteKey = (
  site: Pick<BrowserObservedSite, 'origin' | 'topLevelOrigin'>,
): string => JSON.stringify([site.origin, site.topLevelOrigin]);
function validate(
  value: unknown,
  profileId: string,
  generation: number,
): asserts value is Observations {
  if (
    !isProfileRecord(value) ||
    value.schemaVersion !== 1 ||
    value.profileId !== profileId ||
    value.storageGeneration !== generation ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.sites) ||
    value.sites.length > 1000 ||
    value.sites.some(
      (site) =>
        !isProfileRecord(site) ||
        Object.keys(site).some(
          (key) =>
            ![
              'origin',
              'topLevelOrigin',
              'cookieDomain',
              'observedAt',
            ].includes(key),
        ) ||
        !origin(site.origin) ||
        !origin(site.topLevelOrigin) ||
        (site.cookieDomain !== null &&
          (typeof site.cookieDomain !== 'string' ||
            site.cookieDomain.length > 253 ||
            !/^[a-z0-9.:[\]-]+$/i.test(site.cookieDomain))) ||
        !Number.isSafeInteger(site.observedAt) ||
        Number(site.observedAt) < 0,
    )
  )
    throw new BrowserProfileError(
      'recovery_required',
      'Observed browser sites could not be read. Original metadata was preserved.',
    );
}

/** Metadata-only observer. No filesystem traversal, cookies, site values, or Session construction. */
export class BrowserObservedSites {
  private readonly pending = new Map<string, Observations>();
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  private closed = false;
  private readonly failures = new Map<string, unknown>();
  constructor(
    readonly root: string,
    private readonly withGeneration: <T>(
      profileId: string,
      generation: number,
      action: () => Promise<T>,
    ) => Promise<T>,
    private readonly now = Date.now,
  ) {}
  private key(profileId: string, generation: number): string {
    if (
      !isProfileId(profileId) ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid browser observation identity.',
      );
    return `${profileId}-g${generation}`;
  }
  private empty(profileId: string, generation: number): Observations {
    return {
      schemaVersion: 1,
      profileId,
      storageGeneration: generation,
      sites: [],
      truncated: false,
    };
  }
  private mergePending(
    earlier: Observations,
    later: Observations,
  ): Observations {
    const sites = new Map(earlier.sites.map((site) => [siteKey(site), site]));
    for (const site of later.sites) {
      const previous = sites.get(siteKey(site));
      if (!previous || previous.observedAt <= site.observedAt)
        sites.set(siteKey(site), site);
    }
    return {
      ...later,
      sites: Array.from(sites.values()).slice(0, 1000),
      truncated: earlier.truncated || later.truncated || sites.size > 1000,
    };
  }
  record(
    profileId: string,
    generation: number,
    frameOrigin: unknown,
    topOrigin: unknown,
    chromiumDomain: unknown,
  ): void {
    if (this.closed) return;
    const key = this.key(profileId, generation);
    if (!this.pending.has(key) && this.pending.size >= 128) return; // Bounded hot-path memory; inventory stays partial.
    const value = this.pending.get(key) ?? this.empty(profileId, generation);
    const observedOrigin = browserOrigin(frameOrigin),
      topLevelOrigin = browserOrigin(topOrigin);
    if (!observedOrigin || !topLevelOrigin) value.truncated = true;
    else {
      const hostname = new URL(observedOrigin).hostname;
      const domain =
        typeof chromiumDomain === 'string' &&
        /^[a-z0-9.:[\]-]*$/i.test(chromiumDomain)
          ? chromiumDomain ||
            (hostname === 'localhost' || isIP(hostname.replace(/^\[|\]$/g, ''))
              ? hostname
              : null)
          : null;
      const site: BrowserObservedSite = {
        origin: observedOrigin,
        topLevelOrigin,
        cookieDomain:
          domain && (hostname === domain || hostname.endsWith(`.${domain}`))
            ? domain
            : null,
        observedAt: this.now(),
      };
      const index = value.sites.findIndex(
        (previous) => siteKey(previous) === siteKey(site),
      );
      if (index >= 0) value.sites[index] = site;
      else if (value.sites.length < 1000) value.sites.push(site);
      else value.truncated = true;
    }
    this.pending.set(key, value);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch(() => undefined);
      }, 5000);
      this.timer.unref?.();
    }
  }
  async read(profileId: string, generation: number): Promise<Observations> {
    await this.flush();
    const key = this.key(profileId, generation);
    if (this.failures.has(key))
      throw new BrowserProfileError(
        'storage_unavailable',
        'Observed sites are temporarily unavailable. Retry inventory.',
      );
    const value = await readProfileJson(join(this.root, `${key}.json`));
    if (value === undefined) return this.empty(profileId, generation);
    validate(value, profileId, generation);
    return value;
  }
  flush(): Promise<void> {
    if (this.flushing)
      return this.flushing.then(() =>
        this.pending.size ? this.flush() : undefined,
      );
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = Array.from(this.pending);
    this.pending.clear();
    this.flushing = (async (): Promise<void> => {
      for (const [key, pending] of batch) {
        try {
          await this.withGeneration(
            pending.profileId,
            pending.storageGeneration,
            () =>
              withProfileWriter(this.root, async () => {
                const path = join(this.root, `${key}.json`);
                const raw = await readProfileJson(path);
                const previous =
                  raw ??
                  this.empty(pending.profileId, pending.storageGeneration);
                validate(
                  previous,
                  pending.profileId,
                  pending.storageGeneration,
                );
                const sites = new Map(
                  previous.sites.map((site) => [siteKey(site), site]),
                );
                for (const site of pending.sites) {
                  const existing = sites.get(siteKey(site));
                  if (!existing || existing.observedAt <= site.observedAt)
                    sites.set(siteKey(site), site);
                }
                await writeProfileJson(path, {
                  ...pending,
                  sites: Array.from(sites.values()).slice(0, 1000),
                  truncated:
                    previous.truncated ||
                    pending.truncated ||
                    sites.size > 1000,
                });
              }),
          );
          this.failures.delete(key);
        } catch (error) {
          const newer = this.pending.get(key);
          this.pending.set(
            key,
            newer ? this.mergePending(pending, newer) : pending,
          );
          this.failures.set(key, error);
        }
      }
    })().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.flush();
  }
}
