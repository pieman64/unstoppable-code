/** @jest-environment jsdom */
import { act, useRef, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyClient } from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import type {
  ScriptAction,
  ScriptActionsSnapshot,
} from '@canopy/protocol/script-actions';
import {
  isTerminalDraft,
  useTerminalComposerMode,
  type TerminalComposerMode,
} from '../../../code/composer/terminal-mode';
import { runCommandInTerminal } from '../../run-command-in-terminal';
import {
  useScriptActionsReviewRequests,
  type ScriptActionsReviewOpenRequest,
} from '../../review-requests';
import { ScriptTypeaheadMenu } from '../ScriptTypeaheadMenu';
import {
  useScriptTypeahead,
  type ScriptTypeaheadController,
} from '../use-script-typeahead';
import { scriptAction, scriptSnapshot } from './fixtures';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

interface Call {
  readonly name: string;
  readonly args: unknown;
}

interface FakeClient {
  readonly client: unknown;
  readonly queries: Call[];
  readonly commands: Call[];
  readonly rescans: Call[];
}

interface KeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
  readonly preventDefault: jest.Mock;
}

interface MountedView extends FakeClient {
  readonly rerender: (props: {
    selectedRepoId?: string | null;
    caretOnFirstLine?: boolean;
  }) => Promise<void>;
}

function fakeClient(options: {
  snapshots: ScriptActionsSnapshot[];
  terminalPty?: boolean;
  spawnFails?: boolean;
  rescannedSnapshot?: ScriptActionsSnapshot;
}): FakeClient {
  const queries: Call[] = [];
  const commands: Call[] = [];
  const rescans: Call[] = [];
  let listCount = 0;
  const query = jest.fn((name: string, args: unknown) => {
    queries.push({ name, args });
    const index = Math.min(listCount, options.snapshots.length - 1);
    listCount += 1;
    return Promise.resolve(options.snapshots[index]);
  });
  const command = jest.fn((name: string, args: unknown) => {
    if (name === 'scriptActions.rescan') {
      rescans.push({ name, args });
      const index = Math.min(listCount, options.snapshots.length - 1);
      listCount += 1;
      return Promise.resolve(
        options.rescannedSnapshot ?? options.snapshots[index],
      );
    }
    commands.push({ name, args });
    if (name === 'terminal.spawn')
      return options.spawnFails
        ? Promise.reject(new Error('spawn failed'))
        : Promise.resolve({ id: `t${commands.length}` });
    return Promise.resolve('written');
  });
  const client = {
    capabilities: {
      localExecution: true,
      terminalPty: options.terminalPty ?? true,
      scriptActions: true,
      fileSystemAccess: 'read-write',
      voice: false,
      settingsScope: 'full',
      pipelines: 'full',
      routing: 'url',
    },
    query,
    command,
    subscribe: (): (() => void) => () => undefined,
  };
  return { client, queries, commands, rescans };
}

function isCanopyClient(value: unknown): value is CanopyClient {
  return typeof value === 'object' && value !== null && 'command' in value;
}

interface HarnessHandle {
  typeahead: ScriptTypeaheadController;
  terminal: TerminalComposerMode;
  draft: string;
  setDraft: (text: string) => void;
}

let handle: HarnessHandle;

function Harness({
  client,
  initialDraft,
  selectedRepoId,
  caretOnFirstLine,
  onReview,
}: {
  client: CanopyClient;
  initialDraft: string;
  selectedRepoId: string | null;
  caretOnFirstLine: boolean;
  onReview: (request: ScriptActionsReviewOpenRequest) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(initialDraft);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  useScriptActionsReviewRequests(onReview);
  const typeahead = useScriptTypeahead({
    available: true,
    terminalMode: isTerminalDraft(draft),
    projectId: 'p1',
    worktreeId: 'w1',
    selectedRepoId,
    draftText: draft,
    caretOnFirstLine,
    replaceDraft: setDraft,
  });
  const terminal = useTerminalComposerMode({
    draftText: draft,
    enabled: true,
    runInTerminal: async (command) => {
      const submission = await typeahead.resolveSubmission();
      const repo =
        submission.kind === 'script'
          ? submission.selectedRepoId
          : (selectedRepoId ?? undefined);
      await runCommandInTerminal({
        client,
        spawn: {
          projectId: 'p1',
          worktreeId: 'w1',
          ...(repo ? { selectedRepoId: repo } : {}),
          ...(submission.kind === 'script' && submission.relativeCwd
            ? { relativeCwd: submission.relativeCwd }
            : {}),
          cols: 80,
          rows: 24,
        },
        command: submission.kind === 'script' ? submission.command : command,
      });
    },
    onSent: () => {
      setDraft('');
      typeahead.reset();
    },
  });
  handle = { typeahead, terminal, draft, setDraft };
  return (
    <div ref={composerRef} data-testid="composer">
      <span ref={anchorRef} />
      <div ref={editorRef} data-testid="editor" />
      <button
        type="button"
        data-testid="run"
        onClick={() => void terminal.send()}
      >
        Run
      </button>
      {typeahead.enabled ? (
        <ScriptTypeaheadMenu
          typeahead={typeahead}
          anchorRef={anchorRef}
          boundaryRef={editorRef}
          composerRef={composerRef}
        />
      ) : null}
    </div>
  );
}

function key(
  name: string,
  modifiers: Partial<{
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    isComposing: boolean;
  }> = {},
): KeyEvent {
  return {
    key: name,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...modifiers,
    preventDefault: jest.fn(),
  };
}

describe('useScriptTypeahead', () => {
  let container: HTMLDivElement;
  let root: Root;
  let reviews: ScriptActionsReviewOpenRequest[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    reviews = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount(
    snapshots: ScriptActionsSnapshot[],
    options: {
      draft?: string;
      selectedRepoId?: string | null;
      caretOnFirstLine?: boolean;
      terminalPty?: boolean;
      spawnFails?: boolean;
      rescannedSnapshot?: ScriptActionsSnapshot;
    } = {},
  ): Promise<MountedView> {
    const fake = fakeClient({
      snapshots,
      ...(options.terminalPty === undefined
        ? {}
        : { terminalPty: options.terminalPty }),
      ...(options.rescannedSnapshot
        ? { rescannedSnapshot: options.rescannedSnapshot }
        : {}),
      ...(options.spawnFails ? { spawnFails: true } : {}),
    });
    if (!isCanopyClient(fake.client)) throw new Error('fake client');
    const client = fake.client;
    const render = (props: {
      selectedRepoId?: string | null;
      caretOnFirstLine?: boolean;
    }): void =>
      root.render(
        <CanopyClientProvider client={client}>
          <Harness
            client={client}
            initialDraft={options.draft ?? '!'}
            selectedRepoId={
              props.selectedRepoId ?? options.selectedRepoId ?? null
            }
            caretOnFirstLine={
              props.caretOnFirstLine ?? options.caretOnFirstLine ?? true
            }
            onReview={(request) => reviews.push(request)}
          />
        </CanopyClientProvider>,
      );
    act(() => {
      render({});
    });
    await flush();
    return {
      ...fake,
      rerender: async (props: {
        selectedRepoId?: string | null;
        caretOnFirstLine?: boolean;
      }): Promise<void> => {
        act(() => render(props));
        await flush();
      },
    };
  }

  async function flush(): Promise<void> {
    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  async function type(text: string): Promise<void> {
    act(() => handle.setDraft(text));
    await flush();
  }

  /** The desktop composer's order: typeahead first, then send on Enter. */
  async function press(event: KeyEvent): Promise<boolean> {
    let handled = false;
    act(() => {
      handled = handle.typeahead.handleKeyDown(event);
    });
    if (!handled && event.key === 'Enter' && !event.shiftKey) {
      await act(async () => {
        await handle.terminal.send();
      });
    }
    await flush();
    return handled;
  }

  function rowLabels(): string[] {
    return Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-action-row]'),
    ).map((row) => row.textContent ?? '');
  }

  const dev = scriptAction('dev', {
    command: 'pnpm run dev',
    packagePath: 'apps/web',
  });
  const build = scriptAction('build');
  const pending = scriptAction('lint', { status: 'pending' });

  it('shows approved scripts and a separate review row for an empty query', async () => {
    await mount([scriptSnapshot([dev, pending, build])]);
    expect(handle.typeahead.open).toBe(true);
    expect(handle.typeahead.suggestions.map((row) => row.action.id)).toEqual([
      'dev',
      'build',
    ]);
    expect(rowLabels()).toEqual([
      expect.stringContaining('dev'),
      expect.stringContaining('build'),
      expect.stringContaining('Review 1 detected script'),
    ]);
    expect(handle.typeahead.activeIndex).toBe(0);
  });

  it('opens only with the caret on the first line', async () => {
    const view = await mount([scriptSnapshot([dev])], {
      caretOnFirstLine: false,
    });
    expect(handle.typeahead.open).toBe(false);
    await view.rerender({ caretOnFirstLine: true });
    expect(handle.typeahead.open).toBe(true);
  });

  it('wraps the arrow keys through the review row and opens review from it', async () => {
    await mount([scriptSnapshot([dev, pending, build])]);
    await press(key('ArrowUp'));
    expect(handle.typeahead.activeIndex).toBe(2);
    await press(key('ArrowDown'));
    expect(handle.typeahead.activeIndex).toBe(0);
    await press(key('ArrowDown'));
    await press(key('ArrowDown'));
    expect(handle.typeahead.activeIndex).toBe(2);
    expect(await press(key('Enter'))).toBe(true);
    expect(reviews).toEqual([
      { projectId: 'p1', worktreeId: 'w1', source: 'composer' },
    ]);
    expect(handle.draft).toBe('!');
  });

  it('keeps raw sends when only the review row is offered', async () => {
    const view = await mount([scriptSnapshot([dev, pending])]);
    await type('!ls -la');
    expect(handle.typeahead.open).toBe(true);
    expect(handle.typeahead.suggestions).toHaveLength(0);
    expect(await press(key('Enter'))).toBe(false);
    expect(view.commands).toEqual([
      {
        name: 'terminal.spawn',
        args: { projectId: 'p1', worktreeId: 'w1', cols: 80, rows: 24 },
      },
      { name: 'terminal.write', args: { terminalId: 't1', data: 'ls -la\n' } },
    ]);
    expect(reviews).toHaveLength(0);
  });

  it('fills the composer on selection and runs on the second Enter', async () => {
    const view = await mount([scriptSnapshot([dev, build])]);
    await type('!de');
    expect(await press(key('Enter'))).toBe(true);
    expect(handle.draft).toBe('!pnpm run dev');
    expect(view.commands).toHaveLength(0);
    expect(handle.typeahead.open).toBe(false);
    expect(handle.typeahead.invocation?.actionId).toBe('dev');
    expect(handle.typeahead.hint).toBe('Runs in web/apps/web');
    expect(await press(key('Enter'))).toBe(false);
    expect(view.commands).toEqual([
      {
        name: 'terminal.spawn',
        args: {
          projectId: 'p1',
          worktreeId: 'w1',
          selectedRepoId: 'web',
          relativeCwd: 'apps/web',
          cols: 80,
          rows: 24,
        },
      },
      {
        name: 'terminal.write',
        args: { terminalId: 't1', data: 'pnpm run dev\n' },
      },
    ]);
    expect(handle.draft).toBe('');
  });

  it('selects with Tab as well, never executing', async () => {
    const view = await mount([scriptSnapshot([dev, build])]);
    await type('!bui');
    expect(await press(key('Tab'))).toBe(true);
    expect(handle.draft).toBe('!pnpm run build');
    expect(view.commands).toHaveLength(0);
  });

  it('keeps targeting for appended arguments and drops it for a changed command', async () => {
    const view = await mount([scriptSnapshot([dev])]);
    await press(key('Enter'));
    await type('!pnpm run dev --port 3');
    expect(handle.typeahead.invocation).not.toBeNull();
    await press(key('Enter'));
    expect(view.commands[0]?.args).toMatchObject({ relativeCwd: 'apps/web' });
    expect(view.commands[1]?.args).toMatchObject({
      data: 'pnpm run dev --port 3\n',
    });

    view.commands.length = 0;
    await type('!');
    await press(key('Enter'));
    await type('!pnpm run devx');
    expect(handle.typeahead.invocation).toBeNull();
    await press(key('Escape'));
    await press(key('Enter'));
    // Raw: the composer's own directory, no package.
    expect(view.commands[0]?.args).toEqual({
      projectId: 'p1',
      worktreeId: 'w1',
      cols: 80,
      rows: 24,
    });
    expect(view.commands[1]?.args).toMatchObject({ data: 'pnpm run devx\n' });
  });

  it('drops the picked script when the selected repository changes', async () => {
    const view = await mount([scriptSnapshot([dev])], {
      selectedRepoId: 'web',
    });
    await press(key('Enter'));
    expect(handle.typeahead.invocation).not.toBeNull();
    await view.rerender({ selectedRepoId: 'api' });
    expect(handle.typeahead.invocation).toBeNull();
  });

  it('sends a picked multiline script once, with its full body', async () => {
    const setup = scriptAction('setup', {
      command: 'pnpm install\npnpm build',
      multiline: true,
    });
    const view = await mount([scriptSnapshot([setup])]);
    await press(key('Enter'));
    expect(handle.draft).toBe('!pnpm install\npnpm build');
    await press(key('Enter'));
    const writes = view.commands.filter(
      (call) => call.name === 'terminal.write',
    );
    expect(writes).toEqual([
      {
        name: 'terminal.write',
        args: { terminalId: 't1', data: 'pnpm install\npnpm build\n' },
      },
    ]);
  });

  it('stops with an explanation when the picked script changed', async () => {
    const changed: ScriptAction = { ...dev, revision: 'dev-v2' };
    const view = await mount([
      scriptSnapshot([dev]),
      scriptSnapshot([changed]),
    ]);
    await press(key('Enter'));
    await press(key('Enter'));
    expect(view.commands).toHaveLength(0);
    expect(handle.terminal.error).toBe("Couldn't run: the script changed");
    expect(handle.draft).toBe('!pnpm run dev');
    // No fallback to a raw run on the next Enter either.
    await press(key('Escape'));
    await press(key('Enter'));
    expect(view.commands).toHaveLength(0);
  });

  it('rescans a picked script before sending while list still returns the cached approval', async () => {
    const view = await mount([scriptSnapshot([dev])], {
      rescannedSnapshot: scriptSnapshot([
        { ...dev, revision: 'dev-v2', status: 'pending' },
      ]),
    });
    await press(key('Enter'));
    await press(key('Enter'));
    expect(view.commands).toHaveLength(0);
    expect(handle.terminal.error).toBe("Couldn't run: the script changed");
    expect(handle.draft).toBe('!pnpm run dev');
    expect(view.rescans).toEqual([
      {
        name: 'scriptActions.rescan',
        args: { projectId: 'p1', worktreeId: 'w1' },
      },
    ]);
  });

  it('stops when the picked script lost approval', async () => {
    const view = await mount([
      scriptSnapshot([dev]),
      scriptSnapshot([{ ...dev, status: 'pending' }]),
    ]);
    await press(key('Enter'));
    await press(key('Enter'));
    expect(view.commands).toHaveLength(0);
    expect(handle.terminal.error).toBe("Couldn't run: the script needs review");
  });

  it('keeps the draft and does not retry when the terminal fails', async () => {
    const view = await mount([scriptSnapshot([dev])], { spawnFails: true });
    await press(key('Enter'));
    await press(key('Enter'));
    expect(
      view.commands.filter((call) => call.name === 'terminal.spawn'),
    ).toHaveLength(1);
    expect(handle.terminal.error).toBe("Couldn't send to terminal");
    expect(handle.draft).toBe('!pnpm run dev');
  });

  it('dismisses for the query on Escape and reopens for a new one', async () => {
    await mount([scriptSnapshot([dev, build])]);
    await type('!d');
    expect(await press(key('Escape'))).toBe(true);
    expect(handle.typeahead.open).toBe(false);
    await type('!de');
    expect(handle.typeahead.open).toBe(true);
    await type('!d');
    expect(handle.typeahead.open).toBe(true);
  });

  /** A real mouse press: pointerdown, mouseup, then the click it completes. */
  async function pressWithMouse(testId: string): Promise<void> {
    const target = document.querySelector(`[data-testid="${testId}"]`);
    if (!target) throw new Error(`${testId} missing`);
    act(() => {
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    await flush();
  }

  it('runs a draft from a composer button clicked while the menu is open', async () => {
    const view = await mount([scriptSnapshot([dev, pending])]);
    await type('!ls -la');
    expect(handle.typeahead.open).toBe(true);
    await pressWithMouse('run');
    expect(view.commands).toEqual([
      {
        name: 'terminal.spawn',
        args: { projectId: 'p1', worktreeId: 'w1', cols: 80, rows: 24 },
      },
      { name: 'terminal.write', args: { terminalId: 't1', data: 'ls -la\n' } },
    ]);
    expect(handle.draft).toBe('');
  });

  it('keeps the menu open for presses in the editor', async () => {
    await mount([scriptSnapshot([dev, build])]);
    await pressWithMouse('editor');
    expect(handle.typeahead.open).toBe(true);
  });

  it('leaves IME composition and modified keys alone', async () => {
    const view = await mount([scriptSnapshot([dev])]);
    expect(await press(key('Enter', { isComposing: true }))).toBe(false);
    expect(handle.draft).toBe('!');
    expect(await press(key('Enter', { shiftKey: true }))).toBe(false);
    expect(await press(key('ArrowDown', { metaKey: true }))).toBe(false);
    expect(await press(key('Tab', { shiftKey: true }))).toBe(false);
    expect(handle.draft).toBe('!');
    expect(view.commands).toHaveLength(0);
  });

  it('stays inactive without terminal capability, as on Portal today', async () => {
    const view = await mount([scriptSnapshot([dev])], { terminalPty: false });
    expect(handle.typeahead.enabled).toBe(false);
    expect(handle.typeahead.open).toBe(false);
    expect(view.queries).toHaveLength(0);
    expect(document.querySelector('[data-action-row]')).toBeNull();
  });
});
