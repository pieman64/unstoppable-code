import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { RENDERER_GONE_MARKER } from '../electron/renderer-gone-marker.mjs';

/*
 * CAN-5642: a renderer crash in a performance sample names its cause. Main
 * relays `render-process-gone` through the launcher's console marker; this
 * module keeps those events for the sample record and copies the launch's
 * Crashpad dumps into the run's diagnostics directory before the isolated
 * data root is deleted.
 */

export const MAX_RETAINED_CRASH_DUMP_FILES = 5;
export const MAX_RETAINED_CRASH_DUMP_BYTES = 64 * 1024 * 1024;
const MAX_RENDERER_GONE_EVENTS = 12;
const CRASH_SETTLE_MS = 2_000;
const CRASH_SETTLE_POLL_MS = 100;

/** Parses one relayed main-process console line, or returns null. */
export function parseRendererGoneMessage(text) {
  if (typeof text !== 'string' || !text.startsWith(RENDERER_GONE_MARKER))
    return null;
  try {
    const details = JSON.parse(text.slice(RENDERER_GONE_MARKER.length));
    if (!details || typeof details !== 'object') return null;
    return {
      reason: typeof details.reason === 'string' ? details.reason : null,
      exitCode: Number.isFinite(details.exitCode) ? details.exitCode : null,
      url: typeof details.url === 'string' ? details.url.slice(0, 256) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Starts collecting renderer exits for one launch and resolves its Crashpad
 * directory. Never throws: evidence collection must not fail a sample.
 */
export async function observeRendererCrashes(electronApp) {
  const events = [];
  electronApp.on('console', (message) => {
    const event = parseRendererGoneMessage(message.text());
    if (event && events.length < MAX_RENDERER_GONE_EVENTS)
      events.push({ ...event, observedAt: new Date().toISOString() });
  });
  const crashDumpsDir = await electronApp
    .evaluate(({ app }) => app.getPath('crashDumps'))
    .catch(() => null);
  return { events, crashDumpsDir };
}

/** True for the Playwright failures a renderer exit produces. */
export function isRendererCrashError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /Page crashed|Target crashed|render process gone/i.test(message);
}

/** Waits briefly for main's relay after a crash error, so the record has it. */
export async function settleRendererCrashEvidence(observed, error) {
  if (
    !observed ||
    (!isRendererCrashError(error) && observed.events.length === 0)
  )
    return;
  const deadline = performance.now() + CRASH_SETTLE_MS;
  while (observed.events.length === 0 && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, CRASH_SETTLE_POLL_MS));
}

function dumpFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.dmp')) {
        const stats = statSync(entryPath);
        files.push({
          path: entryPath,
          bytes: stats.size,
          modifiedMs: stats.mtimeMs,
        });
      }
    }
  };
  visit(directory);
  // Newest first: the dump nearest the failure matters most.
  return files.sort((left, right) => right.modifiedMs - left.modifiedMs);
}

/**
 * Copies at most `maxFiles` dumps and `maxBytes` from the launch's Crashpad
 * directory into `destination`, which the caller places under the run's
 * diagnostics output, never inside the checkout.
 */
export function retainCrashDumps({
  source,
  destination,
  maxFiles = MAX_RETAINED_CRASH_DUMP_FILES,
  maxBytes = MAX_RETAINED_CRASH_DUMP_BYTES,
}) {
  if (!source || !existsSync(source))
    return { retained: false, reason: 'no-crash-dumps-directory' };
  if (!destination) return { retained: false, reason: 'no-artifact-directory' };
  const found = dumpFiles(source);
  const kept = [];
  let bytes = 0;
  for (const file of found) {
    if (kept.length >= maxFiles || bytes + file.bytes > maxBytes) continue;
    kept.push(file);
    bytes += file.bytes;
  }
  if (kept.length > 0) mkdirSync(destination, { recursive: true });
  for (const file of kept)
    copyFileSync(file.path, path.join(destination, path.basename(file.path)));
  return {
    retained: kept.length > 0,
    ...(kept.length > 0 ? { directory: destination } : {}),
    files: kept.map((file) => path.basename(file.path)),
    bytes,
    skippedFiles: found.length - kept.length,
  };
}

/**
 * The record fields for a launch's renderer exits: absent when none was seen
 * and none was retained, so a clean sample keeps its earlier shape.
 */
export function rendererCrashRecordFields(observed, crashDumps) {
  return {
    ...(observed?.events.length
      ? { rendererProcessGone: [...observed.events] }
      : {}),
    ...(crashDumps ? { crashDumps } : {}),
  };
}

/** Retains dumps when this launch saw a renderer exit or a crash error. */
export function retainLaunchCrashDumps(observed, error, destination) {
  if (!observed) return undefined;
  if (observed.events.length === 0 && !isRendererCrashError(error))
    return undefined;
  try {
    return retainCrashDumps({ source: observed.crashDumpsDir, destination });
  } catch (copyError) {
    return {
      retained: false,
      reason: 'copy-failed',
      error: copyError instanceof Error ? copyError.message : String(copyError),
    };
  }
}
