import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app as electronApp } from 'electron';

const CONTEXT_FILE_NAME = 'feature-flags-context.json';

const pendingKeysByPath = new Map<string, Promise<string>>();

// Retains the existing feature-flags context file shape for LaunchDarkly
// back-compat even though this module only owns the anonymous install id.
export interface StoredFeatureFlagContext {
  version: 1;
  anonymousKey: string;
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
  await writeStoredContext(filePath, { version: 1, anonymousKey });
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
  const filePath = path.join(
    electronApp.getPath('userData'),
    'posthog-context.json',
  );
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
