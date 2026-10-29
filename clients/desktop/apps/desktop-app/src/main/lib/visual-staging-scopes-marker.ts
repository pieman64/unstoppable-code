/**
 * The data-root marker records that a scope may contain staged chat visuals.
 * Staging publishes the marker before writing its first entry; a clean sweep
 * removes it only if no staging write started while that sweep was running.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fsyncDirectory } from './fsync-directory';
import { getDataDir } from './paths';
import { isErrnoException } from './type-guards';

export const CHAT_VISUAL_STAGING_SCOPES_MARKER_FILE_NAME =
  'chat-visual-staging-scopes.json';
export const CHAT_VISUAL_STAGING_SCOPES_MARKER_VERSION = 1;

export function chatVisualStagingScopesMarkerPath(
  dataDir: string = getDataDir(),
): string {
  return join(dataDir, CHAT_VISUAL_STAGING_SCOPES_MARKER_FILE_NAME);
}

const durable = new Set<string>();
const known = new Map<string, boolean>();
let changes = 0;
let activeStages = 0;
let generation = 0;
let queue: Promise<unknown> = Promise.resolve();

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

function remember(path: string, exists: boolean): void {
  changes += 1;
  known.set(path, exists);
}

function forget(path: string): void {
  changes += 1;
  known.delete(path);
}

async function writeMarker(path: string, dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await open(temporary, 'w');
    try {
      await handle.writeFile(
        `${JSON.stringify({ version: CHAT_VISUAL_STAGING_SCOPES_MARKER_VERSION })}\n`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    renamed = true;
    await fsyncDirectory(dataDir);
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

/** Ensure the marker is durable before a stage writes its document. */
export async function withChatVisualStagingScopesMarker<T>(
  stage: () => Promise<T>,
  dataDir: string = getDataDir(),
): Promise<T> {
  const path = chatVisualStagingScopesMarkerPath(dataDir);
  await exclusive(async () => {
    if (!durable.has(path)) {
      if (known.get(path) !== true) {
        try {
          await writeMarker(path, dataDir);
        } catch (error) {
          forget(path);
          throw error;
        }
        remember(path, true);
      }
      durable.add(path);
    }
    activeStages += 1;
    generation += 1;
  });
  try {
    return await stage();
  } finally {
    await exclusive(() =>
      Promise.resolve().then(() => {
        activeStages -= 1;
        generation += 1;
      }),
    );
  }
}

/** The sweep gate: one stat, with errors other than ENOENT treated as present. */
export async function chatVisualStagingScopesMarkerExists(
  dataDir: string = getDataDir(),
): Promise<boolean> {
  const path = chatVisualStagingScopesMarkerPath(dataDir);
  const before = changes;
  try {
    await stat(path);
    if (changes === before) known.set(path, true);
    return true;
  } catch (error) {
    const absent = isErrnoException(error) && error.code === 'ENOENT';
    if (absent && changes === before) known.set(path, false);
    return !absent;
  }
}

/** Captured when a clean staging sweep starts. */
export function chatVisualStagingPublicationGeneration(): number {
  return generation;
}

/** Remove the marker only after a complete clean pass with no concurrent stage. */
export function removeChatVisualStagingScopesMarker(
  sweepGeneration: number,
  dataDir: string = getDataDir(),
): Promise<boolean> {
  const path = chatVisualStagingScopesMarkerPath(dataDir);
  return exclusive(async () => {
    if (activeStages > 0 || generation !== sweepGeneration) return false;
    durable.delete(path);
    try {
      await rm(path, { force: true });
    } catch (error) {
      forget(path);
      throw error;
    }
    remember(path, false);
    return true;
  });
}

/** Test seam: forget marker state retained by this process. */
export function resetChatVisualStagingScopesMarkerForTests(): void {
  durable.clear();
  known.clear();
  changes += 1;
  generation += 1;
}
