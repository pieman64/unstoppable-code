import { readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveCodexHomeWithoutSpawn } from '../codex/resolve-codex-home';
import { getObservabilityService } from '../observability';

const CODEX_MARKETPLACE_ARTIFACT_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Codex writes backup checkouts into the same directory as LIVE marketplace
 * checkouts, and marketplace names come from repo-supplied `marketplace.json`.
 * A bare `marketplace-backup-` prefix test would therefore delete the live
 * checkout of any marketplace that named itself that way, so the sweep is
 * anchored to the exact shape Codex generates: the prefix plus a fixed-length
 * random alphanumeric suffix. Verified against 2,120 real artifacts on a
 * leaked install - every one is exactly six alphanumerics.
 */
const CODEX_MARKETPLACE_STAGING_DIR_RE =
  /^marketplace-(?:add|upgrade)-[A-Za-z0-9]{6}$/;
const CODEX_MARKETPLACE_BACKUP_DIR_RE = /^marketplace-backup-[A-Za-z0-9]{6}$/;
/**
 * Prefix-only forms of the patterns above. A directory that matches the prefix
 * but NOT the full shape is the signal that Codex renamed its artifacts and
 * the sweep has silently stopped matching. Counting those specifically - rather
 * than every directory in the root, which includes live marketplace checkouts -
 * is what makes the counter answer that question instead of just reporting
 * that the install has marketplaces.
 */
const CODEX_MARKETPLACE_STAGING_PREFIX_RE = /^marketplace-(?:add|upgrade)-/;
const CODEX_MARKETPLACE_BACKUP_PREFIX_RE = /^marketplace-backup-/;

/**
 * Guard a recursive `rm` root. A relative, empty, or filesystem-root
 * `codexHome` must never be expanded into a delete target.
 */
function isSafeSweepRoot(codexHome: string): boolean {
  if (!codexHome || !path.isAbsolute(codexHome)) {
    return false;
  }
  const normalized = path.normalize(codexHome);
  return path.dirname(normalized) !== normalized;
}

async function sweepDirectory(
  directory: string,
  matches: (name: string) => boolean,
  prefixMatches: (name: string) => boolean,
  nowMs: number,
): Promise<{ removed: number; unmatched: number }> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { removed: 0, unmatched: 0 };
  }

  let removed = 0;
  let unmatched = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!matches(entry.name)) {
      if (prefixMatches(entry.name)) {
        unmatched += 1;
      }
      continue;
    }
    const target = path.join(directory, entry.name);
    try {
      const metadata = await stat(target);
      if (nowMs - metadata.mtimeMs < CODEX_MARKETPLACE_ARTIFACT_MIN_AGE_MS) {
        continue;
      }
      await rm(target, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Best effort. A concurrent Codex operation may move or remove entries.
    }
  }
  return { removed, unmatched };
}

export async function sweepCodexMarketplaceStaging(
  nowMs: number = Date.now(),
): Promise<{ removed: number }> {
  try {
    // Deliberately NOT `getCanonicalState()`: that spawns a Codex app-server
    // and installs a permanent profile anchor when no canonical state has been
    // observed yet. This janitor runs from the deferred startup path before
    // `runStartupBackgroundTasks`, and is not behind that path's
    // `platform !== 'win32'` gate, so calling it would give every launch -
    // including a Claude-only Windows launch - an unconditional Codex spawn,
    // re-triggering the boot-time marketplace work this sweep exists to clean
    // up after.
    //
    // Equally deliberately NOT the observed canonical value alone: that is
    // `null` until an app-server has initialized IN THIS PROCESS, and the
    // janitor runs before anything initializes one. Gating on it would make
    // the startup sweep a no-op on every cold launch and leave the 12h
    // interval as the only trigger, so any session shorter than 12h would
    // never reclaim anything - defeating the point of the sweep. The shared
    // resolver prefers observed state and otherwise falls back to the
    // configured or platform-default state directory without spawning.
    const codexHome = await resolveCodexHomeWithoutSpawn();
    if (!isSafeSweepRoot(codexHome)) {
      return { removed: 0 };
    }
    const marketplacesRoot = path.join(codexHome, '.tmp', 'marketplaces');
    const [stagingRemoved, backupRemoved] = await Promise.all([
      sweepDirectory(
        path.join(marketplacesRoot, '.staging'),
        (name) => CODEX_MARKETPLACE_STAGING_DIR_RE.test(name),
        (name) => CODEX_MARKETPLACE_STAGING_PREFIX_RE.test(name),
        nowMs,
      ),
      sweepDirectory(
        marketplacesRoot,
        (name) => CODEX_MARKETPLACE_BACKUP_DIR_RE.test(name),
        (name) => CODEX_MARKETPLACE_BACKUP_PREFIX_RE.test(name),
        nowMs,
      ),
    ]);
    const removed = stagingRemoved.removed + backupRemoved.removed;
    const unmatched = stagingRemoved.unmatched + backupRemoved.unmatched;
    if (removed === 0 && unmatched === 0) {
      // Nothing to say, and nothing to distinguish: a clean install would
      // otherwise record a diagnostic on every launch, including on machines
      // with no Codex state directory at all.
      return { removed };
    }
    // `sweptUnmatched` counts directories carrying the expected PREFIX but not
    // the full shape, so a non-zero value means "Codex renamed its artifacts
    // and the sweep has stopped matching" rather than "this install has
    // marketplaces". Counts only - no paths and no marketplace names.
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'codex_marketplace_staging_swept',
      sweptRemoved: removed,
      sweptStagingRemoved: stagingRemoved.removed,
      sweptBackupRemoved: backupRemoved.removed,
      sweptUnmatched: unmatched,
    });
    return { removed };
  } catch {
    return { removed: 0 };
  }
}
