import {
  CONNECTION_PROVIDERS,
  type ConnectionProvider,
} from './provider-connection-events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app as electronApp } from 'electron';
import type { PostHogInstallLaunch } from '@canopy/desktop-shared/types/observability';
import {
  getCanopyDataDir,
  hasCanopyInstallData,
} from '@canopy/desktop-shared/canopy-paths';

const CONTEXT_FILE_NAME = 'feature-flags-context.json';

const pendingKeysByPath = new Map<string, Promise<string>>();
const keysCreatedThisLaunch = new Set<string>();

// Retains the existing feature-flags context file shape for LaunchDarkly
// back-compat even though this module only owns the anonymous install id.
export interface StoredFeatureFlagContext {
  version: 1;
  anonymousKey: string;
  createdAt?: string;
  invitedInstall?: null | true;
  shipping?: ShippingMilestones;
  providerConnection?: { firstProvider: ConnectionProvider | 'unknown' | null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function contextFilePath(): string {
  return path.join(electronApp.getPath('userData'), CONTEXT_FILE_NAME);
}

async function writeStoredContext(
  filePath: string,
  payload: StoredFeatureFlagContext,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(payload, null, 2));
  await rename(tempPath, filePath);
}

/**
 * Returns a stable, anonymous, per-install identifier persisted to
 * `userData/feature-flags-context.json`. It is a random v4 UUID with no PII,
 * shared with the LaunchDarkly anonymous key so Datadog and LaunchDarkly
 * identities line up. Deleting the file rotates both identities.
 *
 * Kept free of the heavier `account-targeting` transitive chain (brand,
 * GitHub client, Canopy Cloud, Claude/Codex auth) so early-startup callers
 * (instrumentation, observability IPC) can reuse the key cheaply.
 */
async function resolveStableAnonymousKey(filePath: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      isUuid(parsed.anonymousKey)
    ) {
      return parsed.anonymousKey;
    }
  } catch {
    // Missing or invalid files are repaired below.
  }

  const anonymousKey = randomUUID();
  await writeStoredContext(filePath, {
    version: 1,
    anonymousKey,
    ...(filePath === posthogContextFilePath()
      ? {
          createdAt: new Date().toISOString(),
          invitedInstall: null,
          providerConnection: { firstProvider: null },
          shipping: { commit: null, pullRequest: null, merge: null },
        }
      : {}),
  });
  keysCreatedThisLaunch.add(filePath);
  return anonymousKey;
}

export async function getStableAnonymousKey(): Promise<string> {
  const filePath = contextFilePath();
  let pendingKey = pendingKeysByPath.get(filePath);
  if (!pendingKey) {
    pendingKey = resolveStableAnonymousKey(filePath).catch((error: unknown) => {
      pendingKeysByPath.delete(filePath);
      throw error;
    });
    pendingKeysByPath.set(filePath, pendingKey);
  }
  return pendingKey;
}

/** Independent product-analytics identity; never shared with Datadog or LD.
 * Main is the sole writer, including concurrent requests from app windows.
 * Deleting posthog-context.json rotates it on the next app launch. */
export async function getStablePostHogAnonymousKey(): Promise<string> {
  const filePath = posthogContextFilePath();
  let pendingKey = pendingKeysByPath.get(filePath);
  if (!pendingKey) {
    pendingKey = resolveStableAnonymousKey(filePath).catch((error: unknown) => {
      pendingKeysByPath.delete(filePath);
      throw error;
    });
    pendingKeysByPath.set(filePath, pendingKey);
  }
  return pendingKey;
}

function posthogContextFilePath(): string {
  return path.join(electronApp.getPath('userData'), 'posthog-context.json');
}

/**
 * Classifies this launch for `desktop:app_start`. Only the launch that creates
 * the PostHog identity is new to analytics. It is a reinstall when the Canopy
 * data directory, which packaged builds keep outside `userData` and an
 * uninstall leaves in place, already holds install data no plain boot can
 * fabricate. The data directory is read only on that one launch.
 */
export async function getPostHogInstallLaunch(): Promise<PostHogInstallLaunch> {
  await getStablePostHogAnonymousKey();
  const isNewIdentity = keysCreatedThisLaunch.has(posthogContextFilePath());
  const hasInstallData =
    isNewIdentity &&
    hasCanopyInstallData(getCanopyDataDir(), { throwOnReadError: true });
  const invited = await readPostHogInvitedInstall();
  return {
    isFirstLaunch: isNewIdentity && !hasInstallData,
    isReinstall: hasInstallData,
    ...(invited === undefined ? {} : { isInvitedInstall: invited }),
  };
}

export interface FirstProviderConnection {
  is_first_connection: boolean;
  first_connected_provider: ConnectionProvider | 'unknown';
}
type ShippingMilestone = null | true | 'unknown';
interface ShippingMilestones {
  commit: ShippingMilestone;
  pullRequest: ShippingMilestone;
  merge: ShippingMilestone;
}
export type PostHogShippingKind = 'commit' | 'pull_request' | 'merge';

const contextWrites = new Map<string, Promise<unknown>>();

/** Read without creating or repairing an identity, including before SDK startup. */
export async function readPostHogIdentityKey(): Promise<string | undefined> {
  try {
    const filePath = posthogContextFilePath();
    const cached = await pendingKeysByPath.get(filePath);
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !isUuid(parsed.anonymousKey) ||
      (cached !== undefined && parsed.anonymousKey !== cached)
    )
      return undefined;
    return parsed.anonymousKey;
  } catch {
    return undefined;
  }
}

export async function readPostHogInvitedInstall(): Promise<
  boolean | undefined
> {
  try {
    const filePath = posthogContextFilePath();
    const key = await readPostHogIdentityKey();
    if (!key) return undefined;
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!isRecord(parsed) || parsed.anonymousKey !== key) return undefined;
    return parsed.invitedInstall === true
      ? true
      : parsed.invitedInstall === null
        ? false
        : undefined;
  } catch {
    return undefined;
  }
}

export interface PostHogInviteAcceptance {
  is_first_accept_on_install?: boolean;
  install_age_days?: number;
}

/** Same sole writer as provider/shipping claims; never initializes metadata. */
export async function recordPostHogInviteAcceptance(
  expectedKey: string,
  now: number = Date.now(),
  eligible: () => boolean = () => true,
): Promise<PostHogInviteAcceptance> {
  return updatePostHogContext(async (filePath, parsed) => {
    if (!eligible()) throw new Error('PostHog capture disabled.');
    if (parsed.anonymousKey !== expectedKey)
      throw new Error('PostHog identity changed.');
    const marker = parsed.invitedInstall;
    if (marker !== undefined && marker !== null && marker !== true)
      throw new Error('Invalid invited install metadata.');
    const createdAt =
      typeof parsed.createdAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed.createdAt) &&
      Number.isFinite(Date.parse(parsed.createdAt)) &&
      new Date(parsed.createdAt).toISOString() === parsed.createdAt
        ? Date.parse(parsed.createdAt)
        : NaN;
    if (marker !== true)
      await writeStoredContext(filePath, { ...parsed, invitedInstall: true });
    return {
      ...(marker === undefined
        ? {}
        : { is_first_accept_on_install: marker === null }),
      ...(Number.isFinite(createdAt) && Number.isFinite(now)
        ? {
            install_age_days: Math.min(
              365,
              Math.max(0, Math.floor((now - createdAt) / 86_400_000)),
            ),
          }
        : {}),
    };
  });
}

async function updatePostHogContext<T>(
  update: (
    filePath: string,
    parsed: Pick<StoredFeatureFlagContext, 'version' | 'anonymousKey'> &
      Record<string, unknown>,
  ) => Promise<T>,
): Promise<T> {
  const filePath = posthogContextFilePath();
  const previous = contextWrites.get(filePath) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async (): Promise<T> => {
      // Settle initialization if started, but never create or repair identity here.
      const cachedKey = await pendingKeysByPath.get(filePath);
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
      if (
        !isRecord(parsed) ||
        parsed.version !== 1 ||
        !isUuid(parsed.anonymousKey) ||
        (cachedKey !== undefined && parsed.anonymousKey !== cachedKey)
      ) {
        throw new Error(
          'PostHog identity changed before milestone metadata could be saved.',
        );
      }
      // The identity is validated here; each updater validates its own metadata.
      return update(filePath, {
        ...parsed,
        version: 1,
        anonymousKey: parsed.anonymousKey,
      });
    });
  contextWrites.set(filePath, write);
  try {
    return await write;
  } finally {
    if (contextWrites.get(filePath) === write) contextWrites.delete(filePath);
  }
}

function isShippingMilestone(value: unknown): value is ShippingMilestone {
  return value === null || value === true || value === 'unknown';
}

/** Claim only an existing, valid identity; failed reads/writes leave history unknown. */
export async function recordPostHogShippingMilestone(
  kind: PostHogShippingKind,
): Promise<boolean> {
  return updatePostHogContext(async (filePath, parsed) => {
    const stored: unknown = parsed.shipping;
    let shipping: ShippingMilestones;
    if (stored === undefined) {
      shipping = {
        commit: 'unknown',
        pullRequest: 'unknown',
        merge: 'unknown',
      };
    } else {
      if (
        !isRecord(stored) ||
        !isShippingMilestone(stored.commit) ||
        !isShippingMilestone(stored.pullRequest) ||
        !isShippingMilestone(stored.merge)
      ) {
        throw new Error('Invalid shipping milestone metadata.');
      }
      shipping = {
        ...stored,
        commit: stored.commit,
        pullRequest: stored.pullRequest,
        merge: stored.merge,
      };
    }
    const key = kind === 'pull_request' ? 'pullRequest' : kind;
    const isFirst = shipping[key] === null;
    if (isFirst) shipping[key] = true;
    if (stored === undefined || isFirst)
      await writeStoredContext(filePath, { ...parsed, shipping });
    return isFirst;
  });
}

/** Same single writer and atomic file as the anonymous analytics identity. */
export async function recordPostHogProviderConnection(
  provider: ConnectionProvider,
  atStartup: boolean,
): Promise<FirstProviderConnection> {
  return updatePostHogContext(async (filePath, parsed) => {
    let firstProvider: ConnectionProvider | 'unknown' | null = 'unknown';
    if (parsed.providerConnection !== undefined) {
      if (!isRecord(parsed.providerConnection))
        throw new Error('Invalid provider connection metadata.');
      const stored = parsed.providerConnection.firstProvider;
      if (stored === null || stored === 'unknown') firstProvider = stored;
      else {
        const known = CONNECTION_PROVIDERS.find((value) => value === stored);
        if (!known) throw new Error('Invalid first provider.');
        firstProvider = known;
      }
    }
    const isFirstConnection = firstProvider === null && !atStartup;
    if (firstProvider === null) {
      firstProvider = atStartup ? 'unknown' : provider;
      await writeStoredContext(filePath, {
        ...parsed,
        providerConnection: { firstProvider },
      });
    }
    return {
      is_first_connection: isFirstConnection,
      first_connected_provider: firstProvider,
    };
  });
}
