/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type { ScriptActionsSnapshot } from '@canopy/protocol/script-actions';
import {
  ScriptActionsReview,
  type ScriptActionsReviewProps,
} from '../ScriptActionsReview';
import {
  action,
  CodedError,
  createFakeScriptActionsClient,
  snapshotOf,
  type FakeScriptActionsClient,
} from './fake-script-actions-client';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

function render(
  fake: FakeScriptActionsClient,
  props: Partial<ScriptActionsReviewProps> = {},
): void {
  act(() => {
    root.render(
      <CanopyClientProvider client={fake.client}>
        <ScriptActionsReview
          projectId="proj"
          worktreeId="wt"
          shortcutPlatform="darwin"
          {...props}
        />
      </CanopyClientProvider>,
    );
  });
}

function all(testId: string, scope: ParentNode = container): HTMLElement[] {
  return Array.from(
    scope.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
  );
}

function one(testId: string, scope: ParentNode = container): HTMLElement {
  const found = scope.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`missing ${testId}`);
  return found;
}

function input(
  testId: string,
  scope: ParentNode = container,
): HTMLInputElement {
  const found = one(testId, scope);
  if (!(found instanceof HTMLInputElement))
    throw new Error(`${testId} is not an input`);
  return found;
}

function row(
  kind: 'pending' | 'approved' | 'dismissed',
  name: string,
): HTMLElement {
  const found = all(`script-actions-${kind}-row`).find(
    (element) => element.dataset.scriptName === name,
  );
  if (!found) throw new Error(`missing ${kind} row ${name}`);
  return found;
}

function click(element: HTMLElement): void {
  act(() => element.click());
}

function button(testId: string, scope?: ParentNode): HTMLButtonElement {
  const found = one(testId, scope);
  if (!(found instanceof HTMLButtonElement))
    throw new Error(`${testId} is not a button`);
  return found;
}

function reviewCalls(fake: FakeScriptActionsClient): unknown[] {
  return fake.calls
    .filter((call) => call.name === 'scriptActions.review')
    .map((call) => call.args);
}

const PENDING: ScriptActionsSnapshot = snapshotOf([
  action({ name: 'build' }),
  action({ name: 'test' }),
  action({
    name: 'web-dev',
    packagePath: 'apps/web',
    source: {
      kind: 'package-json',
      file: 'apps/web/package.json',
      entry: 'dev',
      line: 5,
    },
  }),
  action({
    id: 'alias:gst',
    kind: 'alias',
    name: 'gst',
    command: 'git status',
    repoId: null,
    repoName: null,
    target: { kind: 'selected-repository' },
    source: { kind: 'shell-alias', file: '~/.zshrc', entry: 'gst', line: 4 },
  }),
]);

describe('ScriptActionsReview selection', () => {
  it('groups pending rows by repository, package and personal aliases', async () => {
    const fake = createFakeScriptActionsClient(PENDING);
    render(fake);
    await flush();
    const labels = all('script-actions-group').map(
      (group) => group.querySelector('span[id]')?.textContent,
    );
    expect(labels).toEqual(['api', 'api/apps/web', 'Personal aliases']);
    const command = one('script-actions-command', row('pending', 'build'));
    expect(command.className).toContain(REPLAY_BLOCK_CLASS);
    expect(row('pending', 'gst').textContent).toContain('~/.zshrc:4');
  });

  it('shows indeterminate group and global states and selects every pending row', async () => {
    const fake = createFakeScriptActionsClient(PENDING);
    render(fake);
    await flush();
    const approve = button('script-actions-approve');
    expect(approve.disabled).toBe(true);

    click(input('script-actions-row-select', row('pending', 'build')));
    const global = input('script-actions-select-all');
    const firstGroup = input(
      'script-actions-group-select',
      all('script-actions-group')[0],
    );
    expect(global.indeterminate).toBe(true);
    expect(global.checked).toBe(false);
    expect(firstGroup.indeterminate).toBe(true);
    expect(approve.disabled).toBe(false);

    click(firstGroup);
    expect(firstGroup.checked).toBe(true);
    expect(firstGroup.indeterminate).toBe(false);

    click(global);
    expect(global.checked).toBe(true);
    expect(global.indeterminate).toBe(false);
    expect(
      all('script-actions-row-select').every(
        (box) => box instanceof HTMLInputElement && box.checked,
      ),
    ).toBe(true);

    click(global);
    expect(
      all('script-actions-row-select').some(
        (box) => box instanceof HTMLInputElement && box.checked,
      ),
    ).toBe(false);
  });

  it('labels each row checkbox with its script name', async () => {
    const fake = createFakeScriptActionsClient(PENDING);
    render(fake);
    await flush();
    const box = input('script-actions-row-select', row('pending', 'test'));
    const labelId = box.getAttribute('aria-labelledby');
    expect(labelId ? document.getElementById(labelId)?.textContent : null).toBe(
      'test',
    );
  });

  it('drops selections whose revision changed and never selects new rows', async () => {
    const fake = createFakeScriptActionsClient(PENDING);
    render(fake);
    await flush();
    click(input('script-actions-select-all'));
    fake.current = snapshotOf([
      action({ name: 'build', revision: 'r2' }),
      action({ name: 'test' }),
      action({ name: 'lint' }),
    ]);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(
      input('script-actions-row-select', row('pending', 'build')).checked,
    ).toBe(false);
    expect(
      input('script-actions-row-select', row('pending', 'test')).checked,
    ).toBe(true);
    expect(
      input('script-actions-row-select', row('pending', 'lint')).checked,
    ).toBe(false);
    expect(input('script-actions-select-all').indeterminate).toBe(true);

    click(button('script-actions-approve'));
    await flush();
    expect(reviewCalls(fake)).toEqual([
      {
        projectId: 'proj',
        worktreeId: 'wt',
        entries: [{ id: 'detected:test', revision: 'r1' }],
        decision: 'approve',
      },
    ]);
  });
});

describe('ScriptActionsReview submission', () => {
  it('splits a mixed selection by store and reports each result', async () => {
    const fake = createFakeScriptActionsClient(PENDING);
    fake.handlers.set('scriptActions.review', (args) => {
      const entries =
        typeof args === 'object' &&
        args !== null &&
        'entries' in args &&
        Array.isArray(args.entries)
          ? args.entries
          : [];
      const alias = entries.some(
        (entry: unknown) =>
          typeof entry === 'object' &&
          entry !== null &&
          'id' in entry &&
          entry.id === 'alias:gst',
      );
      if (alias)
        return Promise.reject(new CodedError('storage_error', 'Disk is full.'));
      fake.current = {
        ...fake.current,
        actions: fake.current.actions.map((entry) =>
          entry.kind === 'alias' ? entry : { ...entry, status: 'approved' },
        ),
      };
      return Promise.resolve(fake.current);
    });
    render(fake);
    await flush();
    click(input('script-actions-select-all'));
    click(button('script-actions-approve'));
    await flush();
    const calls = reviewCalls(fake);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      decision: 'approve',
      entries: [
        { id: 'detected:build' },
        { id: 'detected:test' },
        { id: 'detected:web-dev' },
      ],
    });
    expect(calls[1]).toMatchObject({ entries: [{ id: 'alias:gst' }] });
    expect(one('script-actions-feedback').textContent).toBe(
      "Approved 3 scripts. Couldn't approve 1 personal alias. Disk is full.",
    );
    // The failed alias stays selected for another attempt.
    expect(
      input('script-actions-row-select', row('pending', 'gst')).checked,
    ).toBe(true);
  });

  it('refreshes after a stale revision and asks the user to reselect', async () => {
    const fake = createFakeScriptActionsClient(
      snapshotOf([action({ name: 'build' })]),
    );
    fake.handlers.set('scriptActions.review', () => {
      fake.current = snapshotOf([action({ name: 'build', revision: 'r2' })]);
      return Promise.reject(
        new CodedError(
          'stale_revision',
          'Script definition changed. Refresh and select it again.',
        ),
      );
    });
    render(fake);
    await flush();
    click(input('script-actions-row-select', row('pending', 'build')));
    const listsBefore = fake.calls.filter(
      (call) => call.name === 'scriptActions.list',
    ).length;
    click(button('script-actions-dismiss'));
    await flush();
    const listsAfter = fake.calls.filter(
      (call) => call.name === 'scriptActions.list',
    ).length;
    expect(listsAfter).toBeGreaterThan(listsBefore);
    expect(one('script-actions-feedback').textContent).toBe(
      'Some scripts changed since you selected them. Review them and select again.',
    );
    expect(
      input('script-actions-row-select', row('pending', 'build')).checked,
    ).toBe(false);
    expect(button('script-actions-dismiss').disabled).toBe(true);
  });

  it('disables the footer actions while saving', async () => {
    const fake = createFakeScriptActionsClient(
      snapshotOf([action({ name: 'build' })]),
    );
    let resolve: (() => void) | undefined;
    fake.handlers.set(
      'scriptActions.review',
      () =>
        new Promise((done) => {
          resolve = (): void => done(fake.current);
        }),
    );
    render(fake);
    await flush();
    click(input('script-actions-row-select', row('pending', 'build')));
    click(button('script-actions-approve'));
    expect(button('script-actions-approve').disabled).toBe(true);
    expect(button('script-actions-dismiss').disabled).toBe(true);
    await act(async () => {
      resolve?.();
      await Promise.resolve();
    });
    await flush();
  });
});

describe('ScriptActionsReview approved and dismissed rows', () => {
  const MIXED = snapshotOf([
    action({ name: 'build', status: 'approved' }),
    action({
      id: 'tracked:setup',
      kind: 'tracked',
      name: 'setup',
      status: 'approved',
      source: {
        kind: 'canopy',
        file: 'canopy.json',
        entry: 'setup',
        line: null,
      },
    }),
    action({ name: 'deploy', status: 'dismissed' }),
  ]);

  it('lets detected rows return to review but not tracked rows', async () => {
    const fake = createFakeScriptActionsClient(MIXED);
    render(fake);
    await flush();
    expect(all('script-actions-remove', row('approved', 'setup'))).toHaveLength(
      0,
    );
    click(button('script-actions-remove', row('approved', 'build')));
    await flush();
    expect(reviewCalls(fake)).toEqual([
      {
        projectId: 'proj',
        worktreeId: 'wt',
        entries: [{ id: 'detected:build', revision: 'r1' }],
        decision: 'reset',
      },
    ]);
    expect(row('pending', 'build')).toBeTruthy();
  });

  it('collapses dismissed rows and restores one to review', async () => {
    const fake = createFakeScriptActionsClient(MIXED);
    render(fake);
    await flush();
    expect(all('script-actions-dismissed-row')).toHaveLength(0);
    const toggle = button('script-actions-dismissed-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Show dismissed (1)');
    click(toggle);
    click(button('script-actions-restore', row('dismissed', 'deploy')));
    await flush();
    expect(reviewCalls(fake)).toEqual([
      expect.objectContaining({
        entries: [{ id: 'detected:deploy', revision: 'r1' }],
        decision: 'reset',
      }),
    ]);
    expect(row('pending', 'deploy')).toBeTruthy();
  });

  it('shows conflicts, unavailable reasons and pins', async () => {
    const fake = createFakeScriptActionsClient(
      snapshotOf([
        action({
          name: 'build',
          status: 'approved',
          shortcut: 'CommandOrControl+Shift+B',
          shortcutConflict: 'Already used by test',
        }),
        action({
          name: 'test',
          status: 'approved',
          unavailableReason: 'Repository is not checked out.',
        }),
      ]),
    );
    render(fake, {
      preferencesNote: 'Shortcuts and pins apply on your desktop.',
    });
    await flush();
    expect(
      one('script-actions-shortcut-conflict', row('approved', 'build'))
        .textContent,
    ).toBe('Shortcut is off. Already used by test');
    expect(row('approved', 'test').textContent).toContain(
      'Repository is not checked out.',
    );
    expect(one('script-actions-preferences-note').textContent).toContain(
      'Shortcuts and pins apply on your desktop.',
    );
    click(button('script-actions-pin', row('approved', 'test')));
    await flush();
    expect(
      fake.calls.find((call) => call.name === 'scriptActions.setPinned')?.args,
    ).toEqual({
      projectId: 'proj',
      worktreeId: 'wt',
      id: 'detected:test',
      pinned: true,
    });
  });
});

describe('ScriptActionsReview shortcut recorder', () => {
  function keyDown(target: HTMLElement, init: KeyboardEventInit): void {
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, ...init }),
      );
    });
  }

  const APPROVED = snapshotOf([
    action({ name: 'build', status: 'approved' }),
    action({
      name: 'test',
      status: 'approved',
      shortcut: 'CommandOrControl+Shift+T',
    }),
  ]);

  it('rejects reserved, duplicate and modifier-less chords before saving', async () => {
    const fake = createFakeScriptActionsClient(APPROVED);
    render(fake);
    await flush();
    const scope = row('approved', 'build');
    click(button('script-actions-shortcut-edit', scope));
    const field = input('script-actions-shortcut-input', scope);
    expect(document.activeElement).toBe(field);

    keyDown(field, { code: 'KeyK', key: 'k', metaKey: true });
    expect(one('script-actions-shortcut-validation', scope).textContent).toBe(
      'Already used by Open Command Palette',
    );
    expect(button('script-actions-shortcut-save', scope).disabled).toBe(true);

    keyDown(field, { code: 'KeyT', key: 't', metaKey: true, shiftKey: true });
    expect(one('script-actions-shortcut-validation', scope).textContent).toBe(
      'Already used by test',
    );

    keyDown(field, { code: 'KeyB', key: 'B', shiftKey: true });
    expect(one('script-actions-shortcut-validation', scope).textContent).toBe(
      'Add Command, Control or Alt',
    );

    keyDown(field, { code: 'KeyB', key: 'b', metaKey: true, shiftKey: true });
    expect(all('script-actions-shortcut-validation', scope)).toHaveLength(0);
    click(button('script-actions-shortcut-save', scope));
    await flush();
    expect(
      fake.calls.find((call) => call.name === 'scriptActions.setShortcut')
        ?.args,
    ).toEqual({
      projectId: 'proj',
      worktreeId: 'wt',
      id: 'detected:build',
      accelerator: 'CommandOrControl+Shift+B',
    });
    expect(all('script-actions-shortcut-input', scope)).toHaveLength(0);
    expect(document.activeElement).toBe(
      one('script-actions-shortcut-edit', scope),
    );
  });

  it('cancels on Escape and clears on Backspace', async () => {
    const fake = createFakeScriptActionsClient(APPROVED);
    render(fake);
    await flush();
    const scope = row('approved', 'test');
    click(button('script-actions-shortcut-edit', scope));
    keyDown(input('script-actions-shortcut-input', scope), {
      code: 'Escape',
      key: 'Escape',
    });
    expect(all('script-actions-shortcut-input', scope)).toHaveLength(0);

    click(button('script-actions-shortcut-edit', scope));
    keyDown(input('script-actions-shortcut-input', scope), {
      code: 'Backspace',
      key: 'Backspace',
    });
    click(button('script-actions-shortcut-save', scope));
    await flush();
    expect(
      fake.calls.find((call) => call.name === 'scriptActions.setShortcut')
        ?.args,
    ).toMatchObject({
      id: 'detected:test',
      accelerator: null,
    });
  });

  it('shows the service conflict and keeps the recorder open', async () => {
    const fake = createFakeScriptActionsClient(APPROVED);
    fake.handlers.set('scriptActions.setShortcut', () =>
      Promise.reject(
        new CodedError('shortcut_conflict', 'Already used by Focus app'),
      ),
    );
    render(fake);
    await flush();
    const scope = row('approved', 'build');
    click(button('script-actions-shortcut-edit', scope));
    keyDown(input('script-actions-shortcut-input', scope), {
      code: 'KeyO',
      key: 'o',
      metaKey: true,
      altKey: true,
    });
    click(button('script-actions-shortcut-save', scope));
    await flush();
    expect(one('script-actions-shortcut-error', scope).textContent).toBe(
      'Already used by Focus app',
    );
    expect(all('script-actions-shortcut-input', scope)).toHaveLength(1);
  });

  it('honors host-reserved chords', async () => {
    const fake = createFakeScriptActionsClient(APPROVED);
    render(fake, {
      reservedShortcuts: [
        { accelerator: 'CommandOrControl+Shift+O', title: 'Focus app' },
      ],
    });
    await flush();
    const scope = row('approved', 'build');
    click(button('script-actions-shortcut-edit', scope));
    keyDown(input('script-actions-shortcut-input', scope), {
      code: 'KeyO',
      key: 'o',
      metaKey: true,
      shiftKey: true,
    });
    expect(one('script-actions-shortcut-validation', scope).textContent).toBe(
      'Already used by Focus app',
    );
  });
});

describe('ScriptActionsReview scanning and opt-in', () => {
  it('offers the shell scan only before opt-in', async () => {
    const fake = createFakeScriptActionsClient(
      snapshotOf([action({ name: 'build' })], { shellAliasScanEnabled: false }),
    );
    render(fake);
    await flush();
    click(button('script-actions-scan-shell'));
    await flush();
    expect(
      fake.calls.some(
        (call) => call.name === 'scriptActions.enableShellAliasScan',
      ),
    ).toBe(true);
    expect(all('script-actions-alias-opt-in')).toHaveLength(0);
  });

  it('keeps prior data and shows the error when a rescan fails', async () => {
    const fake = createFakeScriptActionsClient(
      snapshotOf([action({ name: 'build' })]),
    );
    fake.handlers.set('scriptActions.rescan', () =>
      Promise.reject(new Error("Couldn't scan this worktree.")),
    );
    render(fake, { rescanOnMount: true });
    await flush();
    expect(
      fake.calls.filter((call) => call.name === 'scriptActions.rescan'),
    ).toHaveLength(1);
    expect(one('script-actions-scan-error').textContent).toContain(
      "Couldn't scan this worktree. Showing the last results.",
    );
    expect(row('pending', 'build')).toBeTruthy();
    expect(button('script-actions-rescan').disabled).toBe(false);
  });

  it('shows the loading state, then the empty states', async () => {
    const fake = createFakeScriptActionsClient(snapshotOf([]));
    let release: (() => void) | undefined;
    fake.handlers.set(
      'scriptActions.list',
      () =>
        new Promise((done) => {
          release = (): void => done(fake.current);
        }),
    );
    render(fake);
    expect(one('script-actions-loading').textContent).toContain(
      'Loading scripts',
    );
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await flush();
    expect(one('script-actions-pending-empty').textContent).toBe(
      'Nothing needs review.',
    );
    expect(one('script-actions-approved-empty').textContent).toBe(
      'No approved scripts yet.',
    );
  });

  it('renders a notice and makes no calls without the capability', async () => {
    const fake = createFakeScriptActionsClient(snapshotOf([]), {});
    render(fake);
    await flush();
    expect(one('script-actions-review-unsupported')).toBeTruthy();
    expect(fake.calls).toHaveLength(0);
  });
});

it('can clear retained shortcut and pin preferences on a pending action before reapproval', async () => {
  const fake = createFakeScriptActionsClient(
    snapshotOf([action({ shortcut: 'Control+Y', pinned: true })]),
  );
  render(fake);
  await flush();
  click(button('script-actions-clear-shortcut', row('pending', 'build')));
  await flush();
  click(button('script-actions-clear-pin', row('pending', 'build')));
  await flush();
  expect(fake.calls.map((call) => call.name)).toEqual(
    expect.arrayContaining([
      'scriptActions.setShortcut',
      'scriptActions.setPinned',
    ]),
  );
});
