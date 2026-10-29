/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyClient } from '@canopy/app-core';
import type { ScriptAction } from '@canopy/protocol/script-actions';
import type { TerminalSession } from '@canopy/protocol/terminal';
import {
  useRunScriptActionWithClient,
  type UseRunScriptActionOptions,
  type UseRunScriptActionResult,
} from '../use-run-script-action';
import { ScriptActionRunError } from '../script-action-eligibility';
import { TerminalRunError } from '../../run-command-in-terminal';
import { SINGLE_REPOSITORY_TARGET_ID } from '../../typeahead/invocation';
import { type ScriptActionRunOutcome } from '../script-action-run-registry';
import {
  fakeTerminalClient,
  scriptAction,
  terminalSession,
  type FakeTerminalClient,
} from './fixtures';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Options = Omit<UseRunScriptActionOptions, 'host'> & {
  host?: UseRunScriptActionOptions['host'];
};

describe('useRunScriptAction', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: UseRunScriptActionResult;
  let fake: FakeTerminalClient;
  let revealed: TerminalSession[];
  let revealedExisting: TerminalSession[];

  function Probe({
    client,
    options,
  }: {
    client: CanopyClient;
    options: Options;
  }): null {
    latest = useRunScriptActionWithClient(client, {
      host: {
        reveal: (session) => revealed.push(session),
        revealExisting: (session) => revealedExisting.push(session),
        spawnSize: () => ({ cols: 100, rows: 30 }),
      },
      ...options,
    });
    return null;
  }

  function render(options: Partial<Options> = {}, client = fake.client): void {
    if (options.actions) fake.actions = [...options.actions];
    act(() => {
      root.render(
        <Probe
          client={client}
          options={{
            projectId: 'p',
            worktreeId: 'w',
            actions: [scriptAction()],
            active: true,
            ...options,
          }}
        />,
      );
    });
  }

  async function run(
    action: ScriptAction = scriptAction(),
    via: 'pin' | 'shortcut' = 'pin',
  ): Promise<ScriptActionRunOutcome | undefined> {
    let outcome:
      | Awaited<ReturnType<UseRunScriptActionResult['run']>>
      | undefined;
    await act(async () => {
      outcome = await latest.run(action, via);
    });
    return outcome;
  }

  async function runError(
    action: ScriptAction = scriptAction(),
    via: 'pin' | 'shortcut' = 'pin',
  ): Promise<unknown> {
    let caught: unknown;
    await act(async () => {
      await latest.run(action, via).catch((error: unknown) => {
        caught = error;
      });
    });
    return caught;
  }

  beforeEach(() => {
    fake = fakeTerminalClient();
    revealed = [];
    revealedExisting = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('spawns in the action repository and package directory, then writes once', async () => {
    render();
    const outcome = await run();
    expect(outcome?.kind).toBe('started');
    expect(fake.spawns).toEqual([
      {
        projectId: 'p',
        worktreeId: 'w',
        selectedRepoId: 'repo-a',
        relativeCwd: 'apps/web',
        cols: 100,
        rows: 30,
      },
    ]);
    expect(fake.writes).toHaveLength(1);
    // Terminal write identifiers accept lowercase alphanumerics and hyphens.
    expect(fake.writes[0]).toHaveProperty(
      'idempotencyKey',
      expect.stringMatching(/^[a-z0-9][a-z0-9-]*$/),
    );
    expect(fake.writes[0]).toMatchObject({
      terminalId: 't1',
      data: 'pnpm run dev\n',
    });
    expect(revealed.map((session) => session.id)).toEqual(['t1']);
  });

  it('omits the repository for workspace-root actions', async () => {
    const action = scriptAction({
      target: { kind: 'workspace-root' },
      repoId: null,
      packagePath: null,
    });
    render({ actions: [action], selectedRepoId: 'repo-b' });
    await run(action);
    expect(fake.spawns).toEqual([
      { projectId: 'p', worktreeId: 'w', cols: 100, rows: 30 },
    ]);
  });

  it('spawns single-repository actions in the checkout, not a repository named by the sentinel', async () => {
    const action = scriptAction({
      repoId: SINGLE_REPOSITORY_TARGET_ID,
      target: { kind: 'repository', repoId: SINGLE_REPOSITORY_TARGET_ID },
    });
    render({ actions: [action] });
    await run(action);
    expect(fake.spawns).toEqual([
      {
        projectId: 'p',
        worktreeId: 'w',
        relativeCwd: 'apps/web',
        cols: 100,
        rows: 30,
      },
    ]);
  });

  it('reuses only a terminal that still reports a running command', async () => {
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    render();
    await run();
    now = 1000 + 1;

    fake.sessions = [terminalSession('t1', { running: true })];
    const reused = await run();
    expect(reused?.kind).toBe('reused');
    expect(revealedExisting.map((session) => session.id)).toEqual(['t1']);
    expect(fake.spawns).toHaveLength(1);
    expect(fake.writes).toHaveLength(1);

    // Idle shell: the command finished, so a new run starts.
    fake.sessions = [terminalSession('t1', { running: false })];
    const idle = await run();
    expect(idle?.kind).toBe('started');
    expect(fake.spawns).toHaveLength(2);

    // Closed terminal: not listed, so a new run starts.
    now += 1000 + 1;
    fake.sessions = [];
    const closed = await run();
    expect(closed?.kind).toBe('started');
    expect(fake.spawns).toHaveLength(3);
    jest.restoreAllMocks();
  });

  it('treats unknown running state as a new run', async () => {
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    render();
    await run();
    now = 1000 + 1;
    fake.sessions = [terminalSession('t1')];
    const outcome = await run();
    expect(outcome?.kind).toBe('started');
    expect(fake.spawns).toHaveLength(2);
    jest.restoreAllMocks();
  });

  it.each([false, undefined])(
    'starts a new run immediately when running is %s',
    async (running) => {
      render();
      await run();
      fake.sessions = [terminalSession('t1', { running })];
      expect((await run())?.kind).toBe('started');
      expect(fake.spawns).toHaveLength(2);
    },
  );

  it('shares one spawn between simultaneous triggers', async () => {
    render();
    fake.holdSpawn = true;
    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    act(() => {
      first = latest.run(scriptAction(), 'pin');
      second = latest.run(scriptAction(), 'shortcut');
    });
    expect(latest.isPending(scriptAction())).toBe(true);
    await act(async () => {
      await fake.whenSpawned;
      fake.releaseSpawn();
      await Promise.all([first, second]);
    });
    expect(await first).toBe(await second);
    expect(fake.spawns).toHaveLength(1);
    expect(fake.writes).toHaveLength(1);
    expect(latest.isPending(scriptAction())).toBe(false);
  });

  it('surfaces a failed reuse check without spawning', async () => {
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    render();
    await run();
    now = 1000 + 1;
    fake.listError = new Error('IPC closed');
    const error = await runError();
    expect(error).toBeInstanceOf(ScriptActionRunError);
    expect(error).toMatchObject({ code: 'status-unavailable' });
    expect(fake.spawns).toHaveLength(1);
    jest.restoreAllMocks();
  });

  it('keeps alias runs in different selected repositories apart', async () => {
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const alias = scriptAction({
      id: 'alias:gs',
      kind: 'alias',
      name: 'gs',
      command: 'git status',
      repoId: null,
      repoName: null,
      packagePath: null,
      target: { kind: 'selected-repository' },
      source: { kind: 'shell-alias', file: '~/.zshrc', entry: 'gs', line: 1 },
    });
    render({ actions: [alias], selectedRepoId: 'repo-a' });
    await run(alias);
    fake.sessions = [terminalSession('t1', { running: true })];
    act(() =>
      fake.emit('terminal.running-changed', {
        terminalId: 't1',
        running: true,
      }),
    );
    expect(latest.isRunning(alias)).toBe(true);

    render({ actions: [alias], selectedRepoId: 'repo-b' });
    expect(latest.isRunning(alias)).toBe(false);
    now = 1000 + 1;
    const outcome = await run(alias);
    expect(outcome?.kind).toBe('started');
    expect(fake.spawns).toEqual([
      expect.objectContaining({ selectedRepoId: 'repo-a' }),
      expect.objectContaining({ selectedRepoId: 'repo-b' }),
    ]);
    // Neither run queried for reuse across targets.
    expect(fake.listCalls).toHaveLength(0);
    jest.restoreAllMocks();
  });

  it('refreshes approval before running a pin from another consumer snapshot', async () => {
    render();
    fake.actions = [scriptAction({ status: 'pending' })];
    expect(await runError()).toMatchObject({ code: 'not-approved' });
    expect(fake.spawns).toHaveLength(0);
  });

  it.each(['pin', 'shortcut'] as const)(
    'rescans sources before a %s dispatch while the cached approval is unchanged',
    async (via) => {
      render();
      fake.rescannedActions = [
        scriptAction({ revision: 'r2', status: 'pending' }),
      ];
      expect(await runError(scriptAction(), via)).toMatchObject({
        code: 'stale',
      });
      expect(fake.spawns).toHaveLength(0);
      expect(fake.writes).toHaveLength(0);
    },
  );

  it('blocks a run once approval is lost, even from a stale control', async () => {
    const rendered = scriptAction();
    render({ actions: [scriptAction({ status: 'pending' })] });
    const error = await runError(rendered);
    expect(error).toMatchObject({ code: 'not-approved' });
    expect(fake.spawns).toHaveLength(0);
  });

  it('rejects a changed definition rather than retargeting', async () => {
    render({ actions: [scriptAction({ revision: 'r2' })] });
    expect(await runError(scriptAction())).toMatchObject({ code: 'stale' });
    expect(fake.spawns).toHaveLength(0);
  });

  it('refuses unavailable actions and conflicting shortcuts', async () => {
    render({
      actions: [scriptAction({ unavailableReason: 'Shell is not supported.' })],
    });
    expect(await runError()).toMatchObject({
      code: 'unavailable',
      message: 'Shell is not supported.',
    });
    render({
      actions: [
        scriptAction({ shortcutConflict: 'Already used by Find File' }),
      ],
    });
    expect(await runError(scriptAction(), 'shortcut')).toMatchObject({
      code: 'shortcut-conflict',
    });
    // A pin is not a shortcut: the conflict does not block it.
    expect((await run(scriptAction(), 'pin'))?.kind).toBe('started');
  });

  it('requires both scriptActions and terminalPty', async () => {
    const portal = fakeTerminalClient({
      scriptActions: true,
      terminalPty: false,
    });
    render({}, portal.client);
    expect(latest.supported).toBe(false);
    expect(latest.enabled).toBe(false);
    expect(await runError()).toMatchObject({ code: 'unsupported' });
    expect(portal.spawns).toHaveLength(0);

    const cloud = fakeTerminalClient({ terminalPty: true });
    render({}, cloud.client);
    expect(await runError()).toMatchObject({ code: 'unsupported' });
  });

  it('requires an active, writable context on every call', async () => {
    render({ active: false });
    expect(await runError()).toMatchObject({ code: 'inactive' });
    render({ writable: false });
    expect(await runError()).toMatchObject({ code: 'inactive' });
    render({ worktreeId: null });
    expect(await runError()).toMatchObject({ code: 'inactive' });
    expect(fake.spawns).toHaveLength(0);
  });

  it('never retries an ambiguous write and does not register it', async () => {
    render();
    fake.writeError = new Error('write timed out');
    const error = await runError();
    expect(error).toBeInstanceOf(TerminalRunError);
    expect(error).toMatchObject({ stage: 'write' });
    expect(fake.writes).toHaveLength(1);
    expect(latest.isRunning(scriptAction())).toBe(false);
  });

  it('tracks running state from lifecycle events and clears exited terminals', async () => {
    render();
    await run();
    expect(latest.isRunning(scriptAction())).toBe(false);
    act(() =>
      fake.emit('terminal.running-changed', {
        terminalId: 't1',
        running: true,
      }),
    );
    expect(latest.isRunning(scriptAction())).toBe(true);
    act(() =>
      fake.emit('terminal.running-changed', {
        terminalId: 't1',
        running: false,
      }),
    );
    expect(latest.isRunning(scriptAction())).toBe(false);
    act(() =>
      fake.emit('terminal.running-changed', {
        terminalId: 't1',
        running: true,
      }),
    );
    act(() => fake.emit('terminal.exit', { terminalId: 't1' }));
    expect(latest.isRunning(scriptAction())).toBe(false);
    // The exited entry is gone, so the next run neither queries nor reuses.
    await run();
    expect(fake.listCalls).toHaveLength(0);
    expect(fake.spawns).toHaveLength(2);
  });

  it('does not share terminals between clients', async () => {
    render();
    await run();
    act(() =>
      fake.emit('terminal.running-changed', {
        terminalId: 't1',
        running: true,
      }),
    );
    const other = fakeTerminalClient();
    render({}, other.client);
    expect(latest.isRunning(scriptAction())).toBe(false);
    await run();
    expect(other.spawns).toHaveLength(1);
    expect(other.listCalls).toHaveLength(0);
  });
});
