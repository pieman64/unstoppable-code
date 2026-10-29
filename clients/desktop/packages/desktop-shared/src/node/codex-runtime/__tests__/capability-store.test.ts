import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodexCapabilityStore } from '../capability-store';
import type { CodexCapabilityLeaseFile } from '../capability-types';

function makeTreeWritable(directory: string): void {
  if (!fs.existsSync(directory)) {
    return;
  }
  const stats = fs.lstatSync(directory);
  fs.chmodSync(directory, stats.isDirectory() ? 0o700 : 0o600);
  if (stats.isDirectory()) {
    for (const entry of fs.readdirSync(directory)) {
      makeTreeWritable(path.join(directory, entry));
    }
  }
}

class DisappearingCapabilityStore extends CodexCapabilityStore {
  private rootToRemoveBeforeQuarantine: string | undefined;

  removeBeforeQuarantine(rootPath: string): void {
    this.rootToRemoveBeforeQuarantine = rootPath;
  }

  protected override async quarantineIncompleteRoot(
    targetPath: string,
    quarantinePath: string,
  ): Promise<boolean> {
    if (targetPath === this.rootToRemoveBeforeQuarantine) {
      this.rootToRemoveBeforeQuarantine = undefined;
      makeTreeWritable(targetPath);
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    return super.quarantineIncompleteRoot(targetPath, quarantinePath);
  }
}

describe('CodexCapabilityStore', () => {
  let dataDirectory: string;
  let store: CodexCapabilityStore;

  beforeEach(() => {
    dataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'codex-capability-store-'),
    );
    store = new CodexCapabilityStore(dataDirectory);
  });

  afterEach(() => {
    makeTreeWritable(dataDirectory);
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  it('publishes and reuses an immutable content-addressed root', async () => {
    const first = await store.publishRoot({
      files: {
        'plugin.json': '{"name":"example"}',
        'skills/review/SKILL.md': '# Review',
      },
    });
    const second = await store.publishRoot({
      files: {
        'skills/review/SKILL.md': '# Review',
        'plugin.json': '{"name":"example"}',
      },
    });

    expect(second).toEqual(first);
    expect(fs.readFileSync(path.join(first.path, 'plugin.json'), 'utf8')).toBe(
      '{"name":"example"}',
    );
  });

  it('rebuilds an incomplete retained root instead of renaming over it', async () => {
    const request = {
      files: {
        'plugin.json': '{"name":"example"}',
        'skills/review/SKILL.md': '# Review',
      },
    };
    const first = await store.publishRoot(request);
    fs.chmodSync(first.path, 0o700);
    fs.rmSync(path.join(first.path, '.capability-root.json'));
    fs.chmodSync(first.path, 0o500);

    const republished = await store.publishRoot(request);

    expect(republished).toEqual(first);
    expect(
      fs.readFileSync(
        path.join(republished.path, '.capability-root.json'),
        'utf8',
      ),
    ).toContain(`"contentId":"${first.contentId}"`);
    expect(
      fs
        .readdirSync(path.dirname(republished.path))
        .filter((entry) => entry.startsWith('.incomplete-')),
    ).toEqual([]);
  });

  it('rebuilds a retained root with a missing content file', async () => {
    const request = {
      files: {
        'plugin.json': '{"name":"example"}',
        'skills/review/SKILL.md': '# Review',
      },
    };
    const first = await store.publishRoot(request);
    fs.chmodSync(first.path, 0o700);
    fs.rmSync(path.join(first.path, 'plugin.json'));
    fs.chmodSync(first.path, 0o500);

    const republished = await store.publishRoot(request);

    expect(republished).toEqual(first);
    expect(fs.readFileSync(path.join(first.path, 'plugin.json'), 'utf8')).toBe(
      '{"name":"example"}',
    );
  });

  it('rejects unexpected retained content instead of rebuilding', async () => {
    const request = { files: { 'plugin.json': '{"name":"example"}' } };
    const root = await store.publishRoot(request);
    fs.chmodSync(root.path, 0o700);
    fs.writeFileSync(path.join(root.path, 'unexpected.txt'), 'tampered', {
      mode: 0o400,
    });
    fs.chmodSync(root.path, 0o500);

    await expect(store.publishRoot(request)).rejects.toThrow(
      'Capability root contains unexpected files',
    );
  });

  it('rejects surviving-file tampering when another file is missing', async () => {
    const request = {
      files: {
        'plugin.json': '{"name":"example"}',
        'skills/review/SKILL.md': '# Review',
      },
    };
    const root = await store.publishRoot(request);
    const survivingFile = path.join(root.path, 'skills/review/SKILL.md');
    fs.chmodSync(root.path, 0o700);
    fs.rmSync(path.join(root.path, 'plugin.json'));
    fs.chmodSync(survivingFile, 0o600);
    fs.writeFileSync(survivingFile, '# Tampered');
    fs.chmodSync(survivingFile, 0o400);
    fs.chmodSync(root.path, 0o500);

    await expect(store.publishRoot(request)).rejects.toThrow(
      'Capability root file digest mismatch: skills/review/SKILL.md',
    );
  });

  it('rebuilds when an incomplete root disappears before quarantine', async () => {
    const request = { files: { 'plugin.json': '{"name":"example"}' } };
    const disappearingStore = new DisappearingCapabilityStore(dataDirectory);
    const first = await disappearingStore.publishRoot(request);
    disappearingStore.removeBeforeQuarantine(first.path);
    fs.chmodSync(first.path, 0o700);
    fs.rmSync(path.join(first.path, '.capability-root.json'));
    fs.chmodSync(first.path, 0o500);

    const republished = await disappearingStore.publishRoot(request);

    expect(republished).toEqual(first);
    expect(fs.readFileSync(path.join(first.path, 'plugin.json'), 'utf8')).toBe(
      '{"name":"example"}',
    );
  });

  it('does not follow links while removing an incomplete retained root', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const request = { files: { 'plugin.json': '{"name":"example"}' } };
    const first = await store.publishRoot(request);
    const externalFile = path.join(dataDirectory, 'external.txt');
    fs.writeFileSync(externalFile, 'preserve me', { mode: 0o600 });
    fs.chmodSync(first.path, 0o700);
    fs.rmSync(path.join(first.path, '.capability-root.json'));
    fs.symlinkSync(externalFile, path.join(first.path, 'external-link'));
    fs.chmodSync(first.path, 0o500);

    await store.publishRoot(request);

    expect(fs.readFileSync(externalFile, 'utf8')).toBe('preserve me');
    expect(fs.statSync(externalFile).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent publication of the same root', async () => {
    const secondStore = new CodexCapabilityStore(dataDirectory);
    const request = {
      files: {
        'plugin.json': '{"name":"example"}',
        'skills/review/SKILL.md': '# Review',
      },
    };

    const [first, second] = await Promise.all([
      store.publishRoot(request),
      secondStore.publishRoot(request),
    ]);

    expect(second).toEqual(first);
    expect(fs.existsSync(path.join(first.path, '.capability-root.json'))).toBe(
      true,
    );
  });

  it('waits for a slow local publisher without exhausting the filesystem lock retries', async () => {
    const secondStore = new CodexCapabilityStore(dataDirectory);
    const request = { files: { 'slow.md': 'Retain every byte' } };
    let releaseSync = (): void => undefined;
    let enteredSync = (): void => undefined;
    const heldSync = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const syncStarted = new Promise<void>((resolve) => {
      enteredSync = resolve;
    });
    const open = fs.promises.open.bind(fs.promises);
    const openSpy = jest
      .spyOn(fs.promises, 'open')
      .mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith('/slow.md') && args[1] === 'wx') {
          const sync = handle.sync.bind(handle);
          jest.spyOn(handle, 'sync').mockImplementation(async () => {
            enteredSync();
            await heldSync;
            await sync();
          });
        }
        return handle;
      });
    const schedule = global.setTimeout;
    // Exercise the full 300-attempt wait budget without a 30-second test.
    const timerSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation((callback, ms, ...args) =>
        schedule(callback, ms === 100 ? 0 : ms, ...args),
      );
    const first = store.publishRoot(request);
    let second: ReturnType<CodexCapabilityStore['publishRoot']> | undefined;
    try {
      await syncStarted;
      second = secondStore.publishRoot(request);
      const outcome = await Promise.race([
        second.then(
          () => 'published',
          (error: unknown) => error,
        ),
        new Promise<string>((resolve) =>
          schedule(() => resolve('waiting'), 2500),
        ),
      ]);
      expect(outcome).toBe('waiting');
    } finally {
      releaseSync();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      timerSpy.mockRestore();
      openSpy.mockRestore();
    }
    expect(await second).toEqual(await first);
  });

  it('continues queued publication after an earlier publisher fails', async () => {
    const failed = store.publishRoot({ files: {} });
    const next = new CodexCapabilityStore(dataDirectory).publishRoot({
      files: { 'SKILL.md': '# Retained skill' },
    });
    await expect(failed).rejects.toThrow('at least one file');
    const published = await next;
    expect(fs.readFileSync(path.join(published.path, 'SKILL.md'), 'utf8')).toBe(
      '# Retained skill',
    );
  });

  it('snapshots a selected directory and preserves the published content', async () => {
    const source = path.join(dataDirectory, 'source-plugin');
    fs.mkdirSync(path.join(source, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(source, '.codex-plugin', 'plugin.json'),
      '{"name":"example"}',
    );
    const executable = path.join(source, 'scripts', 'run.sh');
    fs.writeFileSync(executable, '#!/bin/sh\necho ok\n', { mode: 0o755 });

    const published = await store.publishSelectedRoots([
      {
        id: 'source-root',
        location: {
          type: 'environment',
          environmentId: 'local',
          path: pathToFileURL(source).href,
        },
      },
    ]);

    expect(published.rootContentIds).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    const [publishedRoot] = published.roots;
    if (!publishedRoot) {
      throw new Error('Expected a published capability root');
    }
    const publishedPath = fileURLToPath(publishedRoot.location.path);
    fs.writeFileSync(executable, '#!/bin/sh\necho changed\n');
    expect(
      fs.readFileSync(path.join(publishedPath, 'scripts', 'run.sh'), 'utf8'),
    ).toBe('#!/bin/sh\necho ok\n');
    if (process.platform !== 'win32') {
      expect(
        fs.statSync(path.join(publishedPath, 'scripts', 'run.sh')).mode & 0o777,
      ).toBe(0o555);
      expect(fs.statSync(publishedPath).mode & 0o222).toBe(0);
    }
  });

  it('rejects links while publishing a selected directory', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const source = path.join(dataDirectory, 'linked-plugin');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'plugin.json'), '{}');
    fs.symlinkSync(path.join(source, 'plugin.json'), path.join(source, 'link'));

    await expect(store.publishDirectory(source)).rejects.toThrow(
      'link or special file',
    );
  });

  it('rejects traversal paths and tampered retained roots', async () => {
    await expect(
      store.publishRoot({ files: { '../secret': 'nope' } }),
    ).rejects.toThrow('Invalid capability root path');

    const root = await store.publishRoot({ files: { 'plugin.json': '{}' } });
    const pluginPath = path.join(root.path, 'plugin.json');
    fs.chmodSync(root.path, 0o700);
    fs.chmodSync(pluginPath, 0o600);
    fs.writeFileSync(pluginPath, '{"tampered":true}');
    fs.chmodSync(pluginPath, 0o400);
    fs.chmodSync(root.path, 0o500);
    await expect(
      store.publishRoot({ files: { 'plugin.json': '{}' } }),
    ).rejects.toThrow('digest mismatch');
  });

  it('recomputes the complete content id instead of trusting retained metadata', async () => {
    const root = await store.publishRoot({ files: { 'plugin.json': '{}' } });
    const pluginPath = path.join(root.path, 'plugin.json');
    const metadataPath = path.join(root.path, '.capability-root.json');
    fs.chmodSync(root.path, 0o700);
    fs.chmodSync(pluginPath, 0o600);
    fs.writeFileSync(pluginPath, '{"changed":true}');
    fs.chmodSync(pluginPath, 0o400);
    fs.chmodSync(metadataPath, 0o600);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as {
      files: Array<{ path: string; sha256: string; mode: number }>;
    };
    const [metadataFile] = metadata.files;
    if (!metadataFile) {
      throw new Error('Expected capability metadata to contain one file');
    }
    metadataFile.sha256 = createHash('sha256')
      .update('{"changed":true}')
      .digest('hex');
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
    fs.chmodSync(metadataPath, 0o400);
    fs.chmodSync(root.path, 0o500);

    await expect(
      store.publishRoot({ files: { 'plugin.json': '{}' } }),
    ).rejects.toThrow('complete digest mismatch');
  });

  it('keeps leased roots and removes unreferenced roots after the grace period', async () => {
    const leased = await store.publishRoot({ files: { 'leased.txt': 'yes' } });
    const unleased = await store.publishRoot({
      files: { 'unleased.txt': 'remove' },
    });
    // Filesystem timestamps can be more precise than Date's milliseconds.
    // Run GC after publication even when mtime rounds past the wall clock.
    const now = new Date(Math.ceil(fs.statSync(unleased.path).mtimeMs) + 1);
    const lease: CodexCapabilityLeaseFile = {
      version: 1,
      threadId: 'thread-1',
      snapshotId: 'snapshot-1',
      rootContentIds: [leased.contentId],
      kind: 'persisted-chat',
      reasoningRouteFamily: 'gateway:deepseek',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await store.writeLease(lease);
    await expect(store.readLease('thread-1')).resolves.toEqual(lease);

    const result = await store.collectGarbage({ now, graceMs: 0 });

    expect(result.retainedContentIds).toContain(leased.contentId);
    expect(result.removedContentIds).toContain(unleased.contentId);
    expect(fs.existsSync(leased.path)).toBe(true);
    expect(fs.existsSync(unleased.path)).toBe(false);
  });

  it('promotes an operation pin only after writing the matching lease', async () => {
    const root = await store.publishRoot({ files: { 'plugin.json': '{}' } });
    const pin = await store.acquireOperationPin([root.contentId]);
    const now = new Date().toISOString();
    await store.promotePinToLease(pin.pinId, {
      version: 1,
      threadId: 'thread-promoted',
      snapshotId: 'snapshot-promoted',
      rootContentIds: [root.contentId],
      kind: 'persisted-chat',
      createdAt: now,
      updatedAt: now,
    });

    const result = await store.collectGarbage({ graceMs: 0 });
    expect(result.retainedContentIds).toContain(root.contentId);
  });

  it('prevents concurrent writers from changing an immutable thread lease', async () => {
    const root = await store.publishRoot({ files: { 'plugin.json': '{}' } });
    const secondStore = new CodexCapabilityStore(dataDirectory);
    const now = new Date().toISOString();
    const lease: CodexCapabilityLeaseFile = {
      version: 1,
      threadId: 'shared-thread',
      snapshotId: 'snapshot-1',
      rootContentIds: [root.contentId],
      kind: 'persisted-chat',
      createdAt: now,
      updatedAt: now,
    };

    await Promise.all([store.writeLease(lease), secondStore.writeLease(lease)]);
    await expect(
      secondStore.writeLease({
        ...lease,
        snapshotId: 'snapshot-2',
      }),
    ).rejects.toThrow('different snapshot');
    await expect(store.readLease('shared-thread')).resolves.toMatchObject({
      snapshotId: 'snapshot-1',
      rootContentIds: [root.contentId],
    });
  });

  it('rejects malformed persisted lease and pin records', async () => {
    const leaseId = 'malformed-thread';
    const leasesDirectory = path.join(
      dataDirectory,
      'codex-capabilities',
      'v1',
      'leases',
    );
    fs.mkdirSync(leasesDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(
        leasesDirectory,
        `${createHash('sha256').update(leaseId).digest('hex')}.json`,
      ),
      '{"version":1,"threadId":42}',
    );
    await expect(store.readLease(leaseId)).rejects.toThrow(
      'Invalid Codex capability lease record',
    );

    const root = await store.publishRoot({ files: { 'plugin.json': '{}' } });
    const pin = await store.acquireOperationPin([root.contentId]);
    fs.writeFileSync(
      path.join(
        dataDirectory,
        'codex-capabilities',
        'v1',
        'pins',
        `${createHash('sha256').update(pin.pinId).digest('hex')}.json`,
      ),
      '{"version":1,"pinId":false}',
    );
    await expect(store.refreshOperationPin(pin.pinId)).rejects.toThrow(
      'Invalid Codex capability operation pin record',
    );
  });

  it('refuses to pin a missing or invalid retained root', async () => {
    await expect(store.acquireOperationPin(['a'.repeat(64)])).rejects.toThrow();
    await expect(
      store.acquireOperationPin(['not-content-addressed']),
    ).rejects.toThrow('Invalid capability root content id');
  });
});
