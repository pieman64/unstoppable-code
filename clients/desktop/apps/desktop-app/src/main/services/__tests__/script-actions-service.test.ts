import { detectRepositoryScripts } from '@canopy/desktop-shared/node/script-detection';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ScriptActionsService,
  type ScriptActionCheckout,
  type ScriptActionsServicePorts,
} from '../script-actions-service';
import type { ScriptAction } from '@canopy/protocol/script-actions';

const context = { projectId: 'project', worktreeId: 'tree' };
describe('script action review durability', () => {
  let root: string;
  let repo: string;
  let service: ScriptActionsService;
  const events: string[] = [];
  const setup = (
    overrides: Partial<ScriptActionsServicePorts> = {},
  ): ScriptActionsService =>
    new ScriptActionsService({
      workspacePath: (): string => join(root, 'state', 'script-actions.json'),
      aliasPath: (): string => join(root, 'script-aliases.json'),
      home: (): string => join(root, 'home'),
      shell: (): 'bash' => 'bash',
      platform: 'linux',
      resolve: (): Promise<ScriptActionCheckout[]> =>
        Promise.resolve([{ repoId: 'repo', repoName: 'Repo', root: repo }]),
      resolveRepositorySources: (): Promise<ScriptActionCheckout[]> =>
        Promise.resolve([{ repoId: 'repo', repoName: 'Repo', root: repo }]),
      tracked: (): Promise<ScriptAction[]> => Promise.resolve([]),
      reservedShortcuts: (): Promise<ReadonlyMap<string, string>> =>
        Promise.resolve(new Map([['Control+Shift+O', 'Focus app']])),
      changed: (target): void => {
        events.push(target.worktreeId);
      },
      ...overrides,
    });
  const manifest = (command: string): Promise<void> =>
    writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: command } }),
    );
  const first = async (): Promise<ScriptAction> => {
    const action = (await service.list(context)).actions[0];
    if (!action) throw new Error('Expected detected action');
    return action;
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'script-actions-'));
    repo = join(root, 'repo');
    await mkdir(repo);
    await mkdir(join(root, 'home'));
    await manifest('echo one');
    events.length = 0;
    service = setup();
  });
  afterEach(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  it('requires current revision review and persists before publishing', async () => {
    await service.rescan(context);
    const action = await first();
    await expect(
      service.setPinned({ ...context, id: action.id, pinned: true }),
    ).rejects.toMatchObject({ code: 'approval_required' });
    await service.review({
      ...context,
      entries: [action],
      decision: 'approve',
    });
    await service.setPinned({ ...context, id: action.id, pinned: true });
    expect((await first()).status).toBe('approved');
    expect(
      JSON.parse(
        await readFile(join(root, 'state/script-actions.json'), 'utf8'),
      ),
    ).toMatchObject({ version: 1 });
    expect(events.length).toBeGreaterThan(0);
    const restored = setup();
    expect((await restored.list(context)).actions[0]).toMatchObject({
      status: 'approved',
      pinned: true,
    });
    await restored.dispose();
    await manifest('echo two');
    await service.rescan(context);
    expect(await first()).toMatchObject({ status: 'pending', pinned: true });
    await expect(
      service.review({ ...context, entries: [action], decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
  });
  it('validates a whole batch and rejects unknown IDs without partial approval', async () => {
    await service.rescan(context);
    const action = await first();
    await expect(
      service.review({
        ...context,
        entries: [action, { id: 'unknown', revision: 'x' }],
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await first()).status).toBe('pending');
  });
  it('requires renewed approval after complete disappearance and reappearance', async () => {
    await service.rescan(context);
    const action = await first();
    await service.review({
      ...context,
      entries: [action],
      decision: 'dismiss',
    });
    await rm(join(repo, 'package.json'));
    await service.rescan(context);
    expect((await service.list(context)).actions).toEqual([]);
    await manifest('echo one');
    await service.rescan(context);
    expect((await first()).status).toBe('pending');
  });
  it('retains inventory on incomplete scans, without granting approval', async () => {
    await service.rescan(context);
    const action = await first();
    await service.review({
      ...context,
      entries: [action],
      decision: 'approve',
    });
    await writeFile(join(repo, 'package.json'), '{');
    const snapshot = await service.rescan(context);
    expect(snapshot.scanStatus).toBe('incomplete');
    expect(snapshot.actions[0]).toMatchObject({ status: 'pending' });
  });
  it('never reads aliases before opt-in and keeps user decisions separate', async () => {
    await writeFile(join(root, 'home/.bashrc'), "alias test='pnpm test'\n");
    await service.rescan(context);
    expect(
      (await service.list(context)).actions.some((a) => a.kind === 'alias'),
    ).toBe(false);
    const snapshot = await service.enableShellAliasScan(context);
    const alias = snapshot.actions.find((a) => a.kind === 'alias');
    if (!alias) throw new Error('Expected alias');
    const detected = snapshot.actions.find(
      (action) => action.kind === 'detected',
    );
    if (!detected) throw new Error('Expected detected action');
    await expect(
      service.review({
        ...context,
        entries: [alias, detected],
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'mixed_stores' });
    await service.review({ ...context, entries: [alias], decision: 'approve' });
    expect(
      JSON.parse(await readFile(join(root, 'script-aliases.json'), 'utf8')),
    ).toMatchObject({ version: 1, enabled: true });
  });
  it('preserves corrupt state and reports storage failures without events', async () => {
    await mkdir(join(root, 'state'));
    await writeFile(join(root, 'state/script-actions.json'), '{bad');
    await expect(service.rescan(context)).rejects.toMatchObject({
      code: 'storage_error',
    });
    expect(events).toEqual([]);
    expect(
      await readFile(join(root, 'state/script-actions.json'), 'utf8'),
    ).toBe('{bad');
  });
  it('tracks operation-correlated receipts and never infers notices from rescans', async () => {
    await service.scanAfterAdd(context, ['repo'], 'add-one');
    expect(
      await service.receipt({ ...context, operationId: 'add-one' }),
    ).toMatchObject({ status: 'complete', pendingCount: 1 });
    await service.rescan(context);
    expect(
      await service.receipt({ ...context, operationId: 'unrelated' }),
    ).toBeNull();
  });
  it('rejects reserved/duplicate bindings and allows clearing preferences after approval loss', async () => {
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { one: 'echo 1', two: 'echo 2' } }),
    );
    const snapshot = await service.rescan(context);
    await service.review({
      ...context,
      entries: snapshot.actions,
      decision: 'approve',
    });
    const one = snapshot.actions[0];
    const two = snapshot.actions[1];
    if (!one || !two) throw new Error('Expected two actions');
    await expect(
      service.setShortcut({
        ...context,
        id: one.id,
        accelerator: 'Ctrl+Shift+O',
      }),
    ).rejects.toMatchObject({ code: 'shortcut_conflict' });
    await expect(
      service.setShortcut({ ...context, id: one.id, accelerator: 'Shift+G' }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    await service.setShortcut({
      ...context,
      id: one.id,
      accelerator: 'Ctrl+Shift+G',
    });
    await expect(
      service.setShortcut({
        ...context,
        id: two.id,
        accelerator: 'Control+Shift+G',
      }),
    ).rejects.toMatchObject({ code: 'shortcut_conflict' });
    await service.setPinned({ ...context, id: one.id, pinned: true });
    await service.review({ ...context, entries: [one], decision: 'reset' });
    await service.setShortcut({
      ...context,
      id: two.id,
      accelerator: 'Control+Shift+G',
    });
    await expect(
      service.review({ ...context, entries: [one], decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'shortcut_conflict' });
    await service.setShortcut({ ...context, id: one.id, accelerator: null });
    await service.setPinned({ ...context, id: one.id, pinned: false });
    expect(
      (await service.list(context)).actions.find(
        (action) => action.id === one.id,
      ),
    ).toMatchObject({ status: 'pending', shortcut: null, pinned: false });
  });
  it('rescans before approving and rejects edits made since the displayed revision', async () => {
    const action = await first();
    await manifest('echo changed before review');
    await expect(
      service.review({ ...context, entries: [action], decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
  });
  it('rescans after an already-running scan that read sources before the request', async () => {
    let pauseNext = false;
    let noteRead = (): void => {};
    let release = (): void => {};
    const read = new Promise<void>((resolve) => {
      noteRead = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    service = setup({
      detectRepository: async (request) => {
        const result = await detectRepositoryScripts(request);
        if (pauseNext) {
          pauseNext = false;
          noteRead();
          await held;
        }
        return result;
      },
    });
    const action = await first();
    await service.review({
      ...context,
      entries: [action],
      decision: 'approve',
    });
    pauseNext = true;
    const priorScan = service.rescan(context);
    await read;
    await manifest('echo changed during scan');
    const freshScan = service.rescan(context);
    release();
    await priorScan;
    expect((await freshScan).actions[0]).toMatchObject({ status: 'pending' });
  });

  it('coalesces simultaneous scans and duplicate add operations', async () => {
    const scans = await Promise.all([
      service.rescan(context),
      service.rescan(context),
    ]);
    expect(scans[0]).toEqual(scans[1]);
    await writeFile(join(repo, 'Makefile'), 'new-target:\n');
    const receipts = await Promise.all([
      service.scanAfterAdd(context, ['repo'], 'same-add'),
      service.scanAfterAdd(context, ['repo'], 'same-add'),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(receipts[0]).toMatchObject({ status: 'complete', pendingCount: 1 });
  });
  it('recovers source-add receipts before any worktree is selected', async () => {
    const receipt = await service.scanWorkspaceAfterAdd(
      context.projectId,
      ['repo'],
      'source-add',
    );
    expect(receipt).toMatchObject({
      worktreeId: null,
      status: 'complete',
      pendingCount: 1,
    });
    expect(
      await service.receipt({
        projectId: context.projectId,
        operationId: 'source-add',
      }),
    ).toEqual(receipt);
    expect((await service.list(context)).actions[0]).toMatchObject({
      status: 'pending',
    });
  });
  it('allows receipt polling while a source scan is still running', async () => {
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scanning = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = setup({
      detectRepository: async (input) => {
        started();
        await gate;
        return detectRepositoryScripts(input);
      },
    });
    const job = slow.scanWorkspaceAfterAdd(
      context.projectId,
      ['repo'],
      'slow-add',
    );
    await scanning;
    const polling = slow.receipt({
      projectId: context.projectId,
      operationId: 'slow-add',
    });
    try {
      const receipt = await Promise.race([
        polling,
        new Promise<undefined>((resolve) => {
          setTimeout(resolve, 100);
        }),
      ]);
      expect(receipt).toMatchObject({ status: 'scanning' });
    } finally {
      release();
      await job;
      await polling;
      await slow.dispose();
    }
  });
  it('compares platform-equivalent modifier sets rather than replacement order', async () => {
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { one: 'echo 1', two: 'echo 2' } }),
    );
    const snapshot = await service.rescan(context);
    await service.review({
      ...context,
      entries: snapshot.actions,
      decision: 'approve',
    });
    const [one, two] = snapshot.actions;
    if (!one || !two) throw new Error('Expected two actions');
    await service.setShortcut({
      ...context,
      id: one.id,
      accelerator: 'CommandOrControl+Alt+Y',
    });
    await expect(
      service.setShortcut({
        ...context,
        id: two.id,
        accelerator: 'Control+Alt+CommandOrControl+Y',
      }),
    ).rejects.toMatchObject({ code: 'shortcut_conflict' });
  });

  it('does not commit or publish an alias scan after its target closes', async () => {
    let closeOnScan = false;
    const { detectShellAliases } =
      await import('@canopy/desktop-shared/node/script-detection');
    service = setup({
      detectAliases: async (input) => {
        if (closeOnScan) service.closeTarget(context);
        return detectShellAliases(input);
      },
    });
    await service.enableShellAliasScan(context);
    const before = await readFile(join(root, 'script-aliases.json'), 'utf8');
    events.length = 0;
    closeOnScan = true;
    await expect(service.rescan(context)).rejects.toMatchObject({
      code: 'invalid_target',
    });
    expect(await readFile(join(root, 'script-aliases.json'), 'utf8')).toBe(
      before,
    );
    expect(events).toEqual([]);
  });

  it('publishes the executing host shortcut platform and reservations', async () => {
    expect((await service.rescan(context)).shortcutContext).toEqual({
      platform: 'linux',
      reserved: [{ accelerator: 'Control+Shift+O', title: 'Focus app' }],
    });
  });

  it('keeps dismissed entries in a rescan response for review consumers', async () => {
    const action = await first();
    await service.review({
      ...context,
      entries: [action],
      decision: 'dismiss',
    });
    const snapshot = await service.rescan(context);
    expect(
      snapshot.actions.find((entry) => entry.id === action.id)?.status,
    ).toBe('dismissed');
    expect((await service.list(context)).actions).toHaveLength(0);
  });
});
