import { mkdtemp, mkdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let codexHome = '';
let observedCodexHome: string | null = null;

const getCanonicalStateMock = jest.fn(() =>
  Promise.resolve({ codexHome: codexHome }),
);

jest.mock('@canopy/desktop-shared/node/codex-runtime', () => ({
  getObservedCanonicalCodexHome: jest.fn(() => observedCodexHome),
}));

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    getCanonicalState: getCanonicalStateMock,
  })),
}));

// The janitor resolves its root through the shared non-spawning resolver, so
// the env fallback is what runs when no app-server has reported yet.
function withCodexHomeEnv(value: string): void {
  process.env.CODEX_HOME = value;
}

const recordAppDiagnosticMock = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: recordAppDiagnosticMock,
  })),
}));

import { sweepCodexMarketplaceStaging } from '../plugins/codex-staging-janitor';

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

describe('Codex marketplace staging janitor', () => {
  beforeEach(() => {
    getCanonicalStateMock.mockClear();
    recordAppDiagnosticMock.mockClear();
  });

  afterEach(async () => {
    if (codexHome) {
      await rm(codexHome, { recursive: true, force: true });
    }
    codexHome = '';
    observedCodexHome = null;
    delete process.env.CODEX_HOME;
  });

  it('removes only recognized marketplace staging directories older than one hour', async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'codex-staging-janitor-'));
    observedCodexHome = null;
    withCodexHomeEnv(codexHome);
    const marketplacesRoot = join(codexHome, '.tmp', 'marketplaces');
    const stagingRoot = join(marketplacesRoot, '.staging');
    // Real Codex artifact names: prefix plus a six-character random suffix.
    const oldUpgrade = join(stagingRoot, 'marketplace-upgrade-02PbsZ');
    const youngAdd = join(stagingRoot, 'marketplace-add-ASzgWm');
    const unrelated = join(stagingRoot, 'unrelated-old');
    const oldBackup = join(marketplacesRoot, 'marketplace-backup-4tkpEC');
    await Promise.all(
      [oldUpgrade, youngAdd, unrelated, oldBackup].map((target) =>
        mkdir(target, { recursive: true }),
      ),
    );
    const nowMs = Date.now();
    const oldDate = new Date(nowMs - 90 * 60_000);
    const youngDate = new Date(nowMs - 10 * 60_000);
    await Promise.all([
      utimes(oldUpgrade, oldDate, oldDate),
      utimes(youngAdd, youngDate, youngDate),
      utimes(unrelated, oldDate, oldDate),
      utimes(oldBackup, oldDate, oldDate),
    ]);

    const result = await sweepCodexMarketplaceStaging(nowMs);

    expect(result).toEqual({ removed: 2 });
    await expect(exists(oldUpgrade)).resolves.toBe(false);
    await expect(exists(oldBackup)).resolves.toBe(false);
    await expect(exists(youngAdd)).resolves.toBe(true);
    await expect(exists(unrelated)).resolves.toBe(true);
    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'codex_marketplace_staging_swept',
        sweptRemoved: 2,
        sweptStagingRemoved: 1,
        sweptBackupRemoved: 1,
        // `unrelated-old` carries neither expected prefix, so it is not a
        // shape-drift candidate.
        sweptUnmatched: 0,
      }),
    );
  });

  it('reports prefix-matching directories that no longer fit the expected shape', async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'codex-staging-janitor-'));
    observedCodexHome = null;
    withCodexHomeEnv(codexHome);
    const stagingRoot = join(codexHome, '.tmp', 'marketplaces', '.staging');
    // Right prefix, wrong suffix shape: what an upstream Codex rename would
    // look like. Nothing is deleted, but the sweep has silently stopped
    // matching and that must be visible in app-events.
    const drifted = join(stagingRoot, 'marketplace-upgrade-LONGERSUFFIX');
    await mkdir(drifted, { recursive: true });
    const nowMs = Date.now();
    const oldDate = new Date(nowMs - 90 * 60_000);
    await utimes(drifted, oldDate, oldDate);

    const result = await sweepCodexMarketplaceStaging(nowMs);

    expect(result).toEqual({ removed: 0 });
    await expect(exists(drifted)).resolves.toBe(true);
    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'codex_marketplace_staging_swept',
        sweptRemoved: 0,
        sweptUnmatched: 1,
      }),
    );
  });

  it('records nothing on a clean install', async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'codex-staging-janitor-'));
    observedCodexHome = null;
    withCodexHomeEnv(codexHome);

    await expect(sweepCodexMarketplaceStaging(Date.now())).resolves.toEqual({
      removed: 0,
    });

    // Nothing removed and no shape drift: a diagnostic here would fire on
    // every launch of every install, including ones with no Codex at all.
    expect(recordAppDiagnosticMock).not.toHaveBeenCalled();
  });

  it('sweeps via the env fallback without starting a Codex app-server', async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'codex-staging-janitor-'));
    // No app-server has initialized in this process. That is the NORMAL state
    // on the deferred startup path, which runs before anything spawns one.
    observedCodexHome = null;
    withCodexHomeEnv(codexHome);
    const marketplacesRoot = join(codexHome, '.tmp', 'marketplaces');
    const oldBackup = join(marketplacesRoot, 'marketplace-backup-4tkpEC');
    await mkdir(oldBackup, { recursive: true });
    const nowMs = Date.now();
    const oldDate = new Date(nowMs - 90 * 60_000);
    await utimes(oldBackup, oldDate, oldDate);

    const result = await sweepCodexMarketplaceStaging(nowMs);

    // Two properties together, and both matter:
    //   1. `getCanonicalState()` is never called - it would spawn an
    //      app-server and install a permanent profile anchor, re-triggering
    //      the boot-time marketplace work this sweep cleans up after.
    //   2. The sweep still HAPPENS. Gating on the observed canonical value
    //      alone would make every cold-launch sweep a no-op and leave the 12h
    //      interval as the only trigger, so sessions shorter than 12h would
    //      never reclaim anything.
    expect(getCanonicalStateMock).not.toHaveBeenCalled();
    expect(result).toEqual({ removed: 1 });
    await expect(exists(oldBackup)).resolves.toBe(false);
  });

  it('preserves a live marketplace checkout whose name resembles a backup dir', async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'codex-staging-janitor-'));
    observedCodexHome = null;
    withCodexHomeEnv(codexHome);
    const marketplacesRoot = join(codexHome, '.tmp', 'marketplaces');
    // Marketplace names come from repo-supplied `marketplace.json` and live in
    // the same directory as Codex's backups, so the prefix alone is not a safe
    // discriminator.
    const liveCheckout = join(marketplacesRoot, 'marketplace-backup-tooling');
    await mkdir(liveCheckout, { recursive: true });
    const nowMs = Date.now();
    const oldDate = new Date(nowMs - 90 * 60_000);
    await utimes(liveCheckout, oldDate, oldDate);

    const result = await sweepCodexMarketplaceStaging(nowMs);

    expect(result).toEqual({ removed: 0 });
    await expect(exists(liveCheckout)).resolves.toBe(true);
  });

  it('refuses to sweep a relative or filesystem-root state directory', async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'codex-staging-janitor-'));
    observedCodexHome = null;
    withCodexHomeEnv('/');

    await expect(sweepCodexMarketplaceStaging(Date.now())).resolves.toEqual({
      removed: 0,
    });

    withCodexHomeEnv('relative/codex');

    await expect(sweepCodexMarketplaceStaging(Date.now())).resolves.toEqual({
      removed: 0,
    });
  });
});
