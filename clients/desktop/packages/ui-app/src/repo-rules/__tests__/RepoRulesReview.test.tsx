/**
 * @jest-environment jsdom
 */
import { StrictMode, act, useRef, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type {
  RepoRuleProposal,
  RepoRulesScanResponse,
  RepoRulesStatus,
} from '@canopy/protocol/repo-rules';
import {
  RepoRulesReview,
  type RepoRulesProjectDecision,
  type RepoRulesReviewProps,
} from '../RepoRulesReview';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const BASE_CAPABILITIES: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  overviewNotifications: false,
};

const SCAN_ID = '0b4c2a9e-63a4-4d8f-9b0f-1d3e5a7c9e11';

function rule(overrides: Partial<RepoRuleProposal> = {}): RepoRuleProposal {
  return {
    id: 'repo-1:.cursor/rules/style.mdc',
    repoId: 'repo-1',
    path: '.cursor/rules/style.mdc',
    kind: 'always',
    description: '',
    globs: [],
    scope: '',
    hash: 'abc',
    bytes: 12,
    selected: true,
    flags: [],
    ...overrides,
  };
}

function scanResponse(
  overrides: Partial<RepoRulesScanResponse> = {},
): RepoRulesScanResponse {
  return {
    scanId: SCAN_ID,
    enabled: false,
    revision: 1,
    proposals: [
      rule(),
      rule({
        id: 'repo-1:.cursor/rules/dup.mdc',
        path: '.cursor/rules/dup.mdc',
        kind: 'agent-requested',
        description: 'Use when writing tests',
        selected: false,
        flags: ['duplicate'],
      }),
    ],
    nestedDirectories: {},
    skipped: [
      { repoId: 'repo-1', path: '.cursor/rules/huge.mdc', reason: 'too-large' },
    ],
    ...overrides,
  };
}

type AppliedResult = Parameters<
  NonNullable<RepoRulesReviewProps['onApplied']>
>[0];

const DISABLED_STATUS: RepoRulesStatus = {
  enabled: false,
  disabledRuleIds: [],
  revision: 0,
};

const ENABLED_STATUS: RepoRulesStatus = {
  enabled: true,
  disabledRuleIds: [],
  revision: 2,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

interface Harness {
  readonly client: CanopyClient;
  readonly query: jest.Mock<Promise<unknown>, [name: QueryName, args: unknown]>;
  readonly command: jest.Mock;
  render(
    props?: Partial<RepoRulesReviewProps>,
    options?: { readonly strict?: boolean },
  ): void;
}

let container: HTMLDivElement;
let root: Root;

function createHarness(
  options: {
    readonly repoRulesImport?: boolean;
    readonly status?: RepoRulesStatus | (() => Promise<RepoRulesStatus>);
    readonly scan?: () => Promise<RepoRulesScanResponse>;
    readonly apply?: () => Promise<RepoRulesStatus>;
    readonly preview?: () => Promise<{ body: string }>;
  } = {},
): Harness {
  const query = jest.fn<Promise<unknown>, [name: QueryName, args: unknown]>(
    (name) => {
      switch (name) {
        case 'repoRules.status':
          return typeof options.status === 'function'
            ? options.status()
            : Promise.resolve(options.status ?? DISABLED_STATUS);
        case 'repoRules.scan':
          return options.scan
            ? options.scan()
            : Promise.resolve(scanResponse());
        case 'repoRules.preview':
          return options.preview
            ? options.preview()
            : Promise.resolve({ body: '<b>Use tabs</b>' });
        default:
          return Promise.reject(new Error(`unexpected ${name}`));
      }
    },
  );
  const command = jest.fn<
    Promise<RepoRulesStatus>,
    [name: CommandName, args: unknown]
  >(() =>
    options.apply
      ? options.apply()
      : Promise.resolve({ ...DISABLED_STATUS, enabled: true, revision: 1 }),
  );
  const client: CanopyClient = {
    capabilities: {
      ...BASE_CAPABILITIES,
      ...(options.repoRulesImport === false ? {} : { repoRulesImport: true }),
    },
    query<K extends QueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      return query(name, args) as Promise<QueryMap[K]['result']>;
    },
    command<K extends CommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      return command(name, args);
    },
    subscribe: () => () => undefined,
  };
  return {
    client,
    query,
    command,
    render(props = {}, renderOptions = {}): void {
      const review = (
        <CanopyClientProvider client={client}>
          <RepoRulesReview
            appName="Canopy"
            workspaces={[
              { id: 'ws-1', name: 'Alpha' },
              { id: 'ws-2', name: 'Beta' },
            ]}
            initialWorkspaceId="ws-1"
            onClose={jest.fn()}
            {...props}
          />
        </CanopyClientProvider>
      );
      act(() => {
        root.render(
          renderOptions.strict ? <StrictMode>{review}</StrictMode> : review,
        );
      });
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function click(element: Element | null): void {
  if (!(element instanceof HTMLElement)) throw new Error('missing element');
  act(() => element.click());
}

function buttonNamed(label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === label,
    ) ?? null
  );
}

function toggles(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="repo-rules-rule-toggle"]',
    ),
  );
}

function callsTo(harness: Harness, name: string): unknown[][] {
  return harness.query.mock.calls.filter(([called]) => called === name);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('RepoRulesReview', () => {
  it.each(['close', 'replace workspace'])(
    'never publishes an old Apply after %s',
    async (replacement) => {
      let finishApply: (status: RepoRulesStatus) => void = () => undefined;
      const harness = createHarness({
        apply: () =>
          new Promise((resolve) => {
            finishApply = resolve;
          }),
      });
      const onApplied = jest.fn();
      const onClose = jest.fn();
      harness.render({ onApplied, onClose });
      await flush();
      expect(onApplied).not.toHaveBeenCalled();
      click(byTestId('repo-rules-apply'));
      if (replacement === 'close') {
        act(() => root.unmount());
        root = createRoot(container);
      } else {
        harness.render({ initialWorkspaceId: 'ws-2', onApplied, onClose });
        await flush();
      }
      await act(async () => {
        finishApply({ ...DISABLED_STATUS, enabled: true, revision: 1 });
        await Promise.resolve();
      });
      expect(onApplied).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it('scans a known workspace right away and opens on the review without a consent step', async () => {
    const scan = deferred<RepoRulesScanResponse>();
    const harness = createHarness({ scan: () => scan.promise });
    harness.render();
    expect(byTestId('repo-rules-scanning')).not.toBeNull();
    expect(harness.query.mock.calls.map(([name]) => name).sort()).toEqual([
      'repoRules.scan',
      'repoRules.status',
    ]);
    expect(harness.query).toHaveBeenCalledWith('repoRules.scan', {
      workspaceId: 'ws-1',
    });
    await act(async () => {
      scan.resolve(scanResponse());
      await Promise.resolve();
    });
    await flush();
    expect(byTestId('repo-rules-review-step')).not.toBeNull();
    expect(byTestId('repo-rules-consent')).toBeNull();
    expect(byTestId('repo-rules-scan')).toBeNull();
    expect(harness.command).not.toHaveBeenCalled();
  });

  it('waits for a project choice before scanning, then scans the chosen project once', async () => {
    const harness = createHarness();
    harness.render({ initialWorkspaceId: undefined });
    await flush();
    expect(byTestId('repo-rules-choose')).not.toBeNull();
    expect(harness.query).not.toHaveBeenCalled();
    click(byTestId('repo-rules-choose-ws-2'));
    await flush();
    expect(callsTo(harness, 'repoRules.scan')).toEqual([
      ['repoRules.scan', { workspaceId: 'ws-2' }],
    ]);
    expect(callsTo(harness, 'repoRules.status')).toEqual([
      ['repoRules.status', { workspaceId: 'ws-2' }],
    ]);
    expect(byTestId('repo-rules-review-step')?.textContent).toContain('Beta');
  });

  it('does not repeat the automatic scan on rerenders or selection edits', async () => {
    const harness = createHarness();
    harness.render();
    await flush();
    harness.render();
    click(toggles()[1] ?? null);
    await flush();
    expect(callsTo(harness, 'repoRules.scan')).toHaveLength(1);
    expect(callsTo(harness, 'repoRules.status')).toHaveLength(1);
  });

  it('reuses the in-flight automatic scan when Strict Mode replays effects', async () => {
    const scan = deferred<RepoRulesScanResponse>();
    const harness = createHarness({ scan: () => scan.promise });
    harness.render({}, { strict: true });
    expect(callsTo(harness, 'repoRules.scan')).toHaveLength(1);
    expect(callsTo(harness, 'repoRules.status')).toHaveLength(1);
    await act(async () => {
      scan.resolve(scanResponse());
      await Promise.resolve();
    });
    await flush();
    expect(byTestId('repo-rules-review-step')).not.toBeNull();
  });

  it('reuses one automatic scan per choice in Strict Mode', async () => {
    const harness = createHarness();
    harness.render({ initialWorkspaceId: undefined }, { strict: true });
    click(byTestId('repo-rules-choose-ws-1'));
    await flush();
    expect(callsTo(harness, 'repoRules.scan')).toHaveLength(1);
    expect(byTestId('repo-rules-review-step')).not.toBeNull();
  });

  it('holds the review until saved status settles so enabled rules never show a turn-on action', async () => {
    const status = deferred<RepoRulesStatus>();
    const harness = createHarness({ status: () => status.promise });
    harness.render();
    await flush();
    expect(byTestId('repo-rules-scanning')).not.toBeNull();
    expect(byTestId('repo-rules-apply')).toBeNull();
    await act(async () => {
      status.resolve(ENABLED_STATUS);
      await Promise.resolve();
    });
    await flush();
    expect(byTestId('repo-rules-apply')?.textContent).toBe('Save');
    expect(byTestId('repo-rules-turn-off')).not.toBeNull();
  });

  it('shows the review when status arrives before the scan', async () => {
    const scan = deferred<RepoRulesScanResponse>();
    const harness = createHarness({
      status: ENABLED_STATUS,
      scan: () => scan.promise,
    });
    harness.render();
    await flush();
    expect(byTestId('repo-rules-scanning')).not.toBeNull();
    await act(async () => {
      scan.resolve(scanResponse());
      await Promise.resolve();
    });
    await flush();
    expect(byTestId('repo-rules-apply')?.textContent).toBe('Save');
  });

  it('settles a rejected status into the existing error notice', async () => {
    const harness = createHarness({
      status: () => Promise.reject(new Error('status down')),
    });
    harness.render();
    await flush();
    expect(byTestId('repo-rules-status-error')).not.toBeNull();
    expect(byTestId('repo-rules-apply')?.textContent).toBe('Turn on 1 rule');
    expect(byTestId('repo-rules-turn-off')).toBeNull();
  });

  it('shows a scan failure while saved status is still loading', async () => {
    const status = deferred<RepoRulesStatus>();
    const harness = createHarness({
      status: () => status.promise,
      scan: () => Promise.reject(new Error('This project has no checkout.')),
    });
    harness.render();
    await flush();
    expect(byTestId('repo-rules-scan-error')?.textContent).toContain(
      'This project has no checkout.',
    );
    expect(byTestId('repo-rules-turn-off')).toBeNull();
    await act(async () => {
      status.resolve(ENABLED_STATUS);
      await Promise.resolve();
    });
    expect(byTestId('repo-rules-turn-off')).not.toBeNull();
  });

  it('resets and ignores late scans when the requested workspace changes', async () => {
    const scans: Deferred<RepoRulesScanResponse>[] = [];
    const harness = createHarness({
      scan: () => {
        const next = deferred<RepoRulesScanResponse>();
        scans.push(next);
        return next.promise;
      },
    });
    harness.render();
    await flush();
    harness.render({ initialWorkspaceId: 'ws-2' });
    await flush();
    expect(callsTo(harness, 'repoRules.scan').at(-1)).toEqual([
      'repoRules.scan',
      { workspaceId: 'ws-2' },
    ]);
    await act(async () => {
      scans[0]?.resolve(scanResponse({ proposals: [rule({ id: 'old' })] }));
      await Promise.resolve();
    });
    expect(byTestId('repo-rules-scanning')).not.toBeNull();
    await act(async () => {
      scans[1]?.resolve(scanResponse());
      await Promise.resolve();
    });
    await flush();
    expect(byTestId('repo-rules-review-step')?.textContent).toContain('Beta');
    expect(toggles()).toHaveLength(2);
    expect(harness.command).not.toHaveBeenCalled();
  });

  it('ignores scans and saved status from an earlier visit after choosing the same project again', async () => {
    const scans: Deferred<RepoRulesScanResponse>[] = [];
    const statuses: Deferred<RepoRulesStatus>[] = [];
    const harness = createHarness({
      scan: () => {
        const next = deferred<RepoRulesScanResponse>();
        scans.push(next);
        return next.promise;
      },
      status: () => {
        const next = deferred<RepoRulesStatus>();
        statuses.push(next);
        return next.promise;
      },
    });
    harness.render({ initialWorkspaceId: undefined });
    click(byTestId('repo-rules-choose-ws-1'));
    await flush();
    click(byTestId('repo-rules-change-project'));
    expect(byTestId('repo-rules-choose')).not.toBeNull();
    click(byTestId('repo-rules-choose-ws-1'));
    await flush();
    expect(scans).toHaveLength(2);
    expect(statuses).toHaveLength(2);
    await act(async () => {
      statuses[0]?.resolve(ENABLED_STATUS);
      scans[0]?.resolve(scanResponse({ proposals: [rule({ id: 'old' })] }));
      await Promise.resolve();
    });
    await flush();
    expect(byTestId('repo-rules-scanning')).not.toBeNull();
    await act(async () => {
      statuses[1]?.resolve(DISABLED_STATUS);
      scans[1]?.resolve(scanResponse());
      await Promise.resolve();
    });
    await flush();
    expect(toggles()).toHaveLength(2);
    expect(byTestId('repo-rules-apply')?.textContent).toBe('Turn on 1 rule');
    expect(byTestId('repo-rules-status-enabled')).toBeNull();
  });

  it('ignores a scan failure from a project the user left', async () => {
    const scan = deferred<RepoRulesScanResponse>();
    const harness = createHarness({ scan: () => scan.promise });
    harness.render({ initialWorkspaceId: undefined });
    click(byTestId('repo-rules-choose-ws-1'));
    click(byTestId('repo-rules-change-project'));
    await act(async () => {
      scan.reject(new Error('late failure'));
      await Promise.resolve();
    });
    expect(byTestId('repo-rules-choose')).not.toBeNull();
    expect(container.textContent).not.toContain('late failure');
  });

  it.each(['success', 'failure'])(
    'does not settle current status with a late %s from an earlier visit to the same project',
    async (outcome) => {
      const previousStatus = deferred<RepoRulesStatus>();
      const currentStatus = deferred<RepoRulesStatus>();
      let visits = 0;
      const harness = createHarness({
        status: () =>
          ++visits === 1 ? previousStatus.promise : currentStatus.promise,
      });
      harness.render({ initialWorkspaceId: undefined });
      click(byTestId('repo-rules-choose-ws-1'));
      await flush();
      click(byTestId('repo-rules-change-project'));
      click(byTestId('repo-rules-choose-ws-1'));
      await flush();

      // The new scan has finished, but its own saved status is still pending.
      await act(async () => {
        if (outcome === 'success') previousStatus.resolve(ENABLED_STATUS);
        else previousStatus.reject(new Error('Previous status failed'));
        await Promise.resolve();
      });
      await flush();
      expect(byTestId('repo-rules-scanning')).not.toBeNull();
      expect(byTestId('repo-rules-apply')).toBeNull();

      await act(async () => {
        currentStatus.resolve(DISABLED_STATUS);
        await Promise.resolve();
      });
      await flush();
      expect(byTestId('repo-rules-apply')?.textContent).toBe('Turn on 1 rule');
      expect(byTestId('repo-rules-status-enabled')).toBeNull();
      expect(byTestId('repo-rules-status-error')).toBeNull();
      expect(callsTo(harness, 'repoRules.status')).toHaveLength(2);
      expect(harness.command).not.toHaveBeenCalled();
    },
  );

  it('keeps a pending saved-status request relevant through retry', async () => {
    const status = deferred<RepoRulesStatus>();
    let attempts = 0;
    const harness = createHarness({
      status: () => status.promise,
      scan: () =>
        ++attempts === 1
          ? Promise.reject(new Error('Scan failed'))
          : Promise.resolve(scanResponse()),
    });
    harness.render();
    await flush();
    click(buttonNamed('Try again'));
    await flush();
    expect(callsTo(harness, 'repoRules.scan')).toHaveLength(2);
    expect(callsTo(harness, 'repoRules.status')).toHaveLength(1);
    expect(byTestId('repo-rules-scanning')).not.toBeNull();
    expect(byTestId('repo-rules-apply')).toBeNull();

    await act(async () => {
      status.resolve(ENABLED_STATUS);
      await Promise.resolve();
    });
    await flush();
    expect(byTestId('repo-rules-apply')?.textContent).toBe('Save');
    expect(byTestId('repo-rules-turn-off')).not.toBeNull();
    expect(harness.command).not.toHaveBeenCalled();
  });

  it('retries once and uses only the newest attempt, without suppressing later scans', async () => {
    const scans: Deferred<RepoRulesScanResponse>[] = [];
    const harness = createHarness({
      scan: () => {
        const next = deferred<RepoRulesScanResponse>();
        scans.push(next);
        return next.promise;
      },
    });
    harness.render();
    await flush();
    await act(async () => {
      scans[0]?.reject(new Error('This project has no checkout.'));
      await Promise.resolve();
    });
    expect(byTestId('repo-rules-scan-error')).not.toBeNull();
    click(buttonNamed('Try again'));
    expect(scans).toHaveLength(2);
    expect(byTestId('repo-rules-scanning')).not.toBeNull();
    await act(async () => {
      scans[1]?.resolve(scanResponse({ proposals: [], skipped: [] }));
      await Promise.resolve();
    });
    await flush();
    expect(byTestId('repo-rules-empty')).not.toBeNull();
    expect(byTestId('repo-rules-apply')).toBeNull();
    expect(buttonNamed('Done')).not.toBeNull();
  });

  it('starts one new attempt from Scan again and shows only its result', async () => {
    const scans: Deferred<RepoRulesScanResponse>[] = [];
    const harness = createHarness({
      apply: () =>
        Promise.reject(new Error('The reviewed checkout changed. Scan again.')),
      scan: () => {
        const next = deferred<RepoRulesScanResponse>();
        scans.push(next);
        return next.promise;
      },
    });
    harness.render();
    await act(async () => {
      scans[0]?.resolve(scanResponse());
      await Promise.resolve();
    });
    await flush();
    click(byTestId('repo-rules-apply'));
    await flush();
    click(byTestId('repo-rules-rescan'));
    expect(byTestId('repo-rules-scanning')).not.toBeNull();
    expect(scans).toHaveLength(2);
    await act(async () => {
      scans[1]?.resolve(
        scanResponse({ proposals: [rule({ id: 'fresh', path: 'fresh.mdc' })] }),
      );
      await Promise.resolve();
    });
    await flush();
    expect(byTestId('repo-rules-rule')?.textContent).toContain('fresh.mdc');
  });

  it('keeps the all-skipped result as an empty review', async () => {
    const harness = createHarness({
      scan: () => Promise.resolve(scanResponse({ proposals: [] })),
    });
    harness.render();
    await flush();
    expect(byTestId('repo-rules-review-step')?.textContent).toContain(
      'No Cursor rules found',
    );
    expect(byTestId('repo-rules-skipped')).not.toBeNull();
    expect(byTestId('repo-rules-empty')).not.toBeNull();
  });

  it('cancels the loading state without saving anything', () => {
    const onClose = jest.fn();
    const scan = deferred<RepoRulesScanResponse>();
    const harness = createHarness({ scan: () => scan.promise });
    harness.render({ onClose });
    click(buttonNamed('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(harness.command).not.toHaveBeenCalled();
  });

  it('does not put a previous scan preview into a refreshed review', async () => {
    let finishPreview: (value: { body: string }) => void = () => undefined;
    let previewCount = 0;
    const harness = createHarness({
      apply: () =>
        Promise.reject(new Error('Cursor rules changed. Scan again.')),
      preview: () =>
        ++previewCount === 1
          ? new Promise((resolve) => {
              finishPreview = resolve;
            })
          : Promise.resolve({ body: 'current body' }),
    });
    harness.render();
    await flush();
    click(byTestId('repo-rules-preview-toggle'));
    click(byTestId('repo-rules-apply'));
    await flush();
    click(byTestId('repo-rules-rescan'));
    await flush();
    click(byTestId('repo-rules-preview-toggle'));
    await flush();
    await act(async () => {
      finishPreview({ body: 'old body' });
      await Promise.resolve();
    });
    expect(byTestId('repo-rules-preview')?.textContent).toBe('current body');
  });

  it('explains scoped always rules and unsupported globs consistently with rendering', async () => {
    const harness = createHarness({
      scan: () =>
        Promise.resolve(
          scanResponse({
            proposals: [
              rule({ scope: 'sub/' }),
              rule({
                id: 'unsupported',
                kind: 'auto',
                flags: ['unsupported-glob'],
              }),
            ],
          }),
        ),
    });
    harness.render();
    await flush();
    const text = byTestId('repo-rules-review-step')?.textContent;
    expect(text).toContain('Before working in this folder');
    expect(text).toContain('explicitly mention');
  });

  it('introduces the review in two sentences and keeps caveats in a collapsed disclosure', async () => {
    const harness = createHarness();
    harness.render();
    await flush();
    expect(byTestId('repo-rules-reassurance')?.textContent).toBe(
      'Canopy reads .cursor/rules and .cursorrules in Alpha. Nothing in the repository changes.',
    );
    expect(
      byTestId('repo-rules-reassurance')?.querySelectorAll('code'),
    ).toHaveLength(2);
    expect(byTestId('repo-rules-review-step')?.textContent).toContain(
      'Applies to new chats. Open chats keep their current rules.',
    );
    const toggle = byTestId('repo-rules-how-rules-work-toggle');
    expect(toggle?.textContent).toBe('How rules work');
    expect(toggle?.tagName).toBe('BUTTON');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    // The real Electron flow asserts visibility. A disclosure may retain its
    // collapsed content in the DOM without exposing it to the user.

    act(() => toggle?.focus());
    expect(document.activeElement).toBe(toggle);
    click(toggle);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const body = byTestId('repo-rules-how-rules-work-body')?.textContent;
    expect(body).toContain(
      'Each new chat reads the current rules, so edits apply without another review. Rules in a new nested folder need another scan.',
    );
    expect(body).toContain('AGENTS.md and CLAUDE.md win when they conflict.');
    expect(body).toContain(
      "Other branches can have different rules. This review scanned the project's repositories.",
    );
    expect(body).toContain(
      "Cursor reads these rules itself and doesn't get a copy.",
    );
    expect(body).toContain(
      'Files a rule points to are checked for existence, not opened. Files read through rules or @file references stay live in chats.',
    );
  });

  it('names the selected checkout when the scan covered one worktree', async () => {
    const harness = createHarness({
      scan: () => Promise.resolve(scanResponse({ worktreeId: 'wt-1' })),
    });
    harness.render();
    await flush();
    click(byTestId('repo-rules-how-rules-work-toggle'));
    expect(byTestId('repo-rules-how-rules-work-body')?.textContent).toContain(
      'This review scanned the selected checkout.',
    );
  });

  it('renders a shared saved-status and scan diagnostic once, and keeps distinct ones', async () => {
    const same = createHarness({
      status: { ...DISABLED_STATUS, diagnostic: 'invalid' },
      scan: () => Promise.resolve(scanResponse({ diagnostic: 'invalid' })),
    });
    same.render();
    await flush();
    const message = "Saved Cursor rule settings couldn't be read";
    expect(
      byTestId('repo-rules-review-step')?.textContent?.split(message),
    ).toHaveLength(2);
    expect(byTestId('repo-rules-status-diagnostic')).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    const distinct = createHarness({
      status: { ...DISABLED_STATUS, diagnostic: 'invalid' },
      scan: () =>
        Promise.resolve(scanResponse({ diagnostic: 'unsupported-version' })),
    });
    distinct.render();
    await flush();
    const text = byTestId('repo-rules-review-step')?.textContent;
    expect(text).toContain(message);
    expect(text).toContain('came from a newer version');
  });

  it('renders the unsupported state and makes no client calls without the capability', () => {
    const harness = createHarness({ repoRulesImport: false });
    harness.render();
    expect(byTestId('repo-rules-unsupported')).not.toBeNull();
    expect(harness.query).not.toHaveBeenCalled();
    expect(harness.command).not.toHaveBeenCalled();
  });

  it('keeps backend selection defaults, lists skipped files without toggles, and applies the unselected ids', async () => {
    const onApplied = jest.fn<void, [AppliedResult]>();
    const onClose = jest.fn();
    const harness = createHarness();
    harness.render({ onApplied, onClose });
    await flush();
    expect(toggles().map((t) => t.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
    ]);
    expect(byTestId('repo-rules-rule')?.textContent).not.toContain('huge');
    expect(byTestId('repo-rules-skipped')?.textContent).toContain(
      'Larger than 64 KB',
    );
    expect(byTestId('repo-rules-apply')?.textContent).toContain(
      'Turn on 1 rule',
    );

    click(toggles()[1] ?? null);
    expect(byTestId('repo-rules-apply')?.textContent).toBe('Turn on 2 rules');
    click(byTestId('repo-rules-apply'));
    await flush();
    expect(harness.command).toHaveBeenCalledWith('repoRules.apply', {
      workspaceId: 'ws-1',
      enabled: true,
      scanId: SCAN_ID,
      disabledRuleIds: [],
    });
    expect(onApplied).toHaveBeenCalledTimes(1);
    const [applied] = onApplied.mock.calls[0] ?? [];
    expect(applied?.workspaceId).toBe('ws-1');
    expect(applied?.status.enabled).toBe(true);
    expect(applied?.ruleCount).toBe(2);
    expect(onClose).toHaveBeenCalled();
  });

  it('renders previews as text and blocks them from session replay', async () => {
    const harness = createHarness();
    harness.render();
    await flush();
    click(byTestId('repo-rules-preview-toggle'));
    await flush();
    expect(harness.query).toHaveBeenCalledWith('repoRules.preview', {
      workspaceId: 'ws-1',
      scanId: SCAN_ID,
      ruleId: 'repo-1:.cursor/rules/style.mdc',
    });
    const preview = byTestId('repo-rules-preview');
    expect(preview?.textContent).toBe('<b>Use tabs</b>');
    expect(preview?.querySelector('b')).toBeNull();
    expect(preview?.classList.contains('ph-no-capture')).toBe(true);
  });

  it('masks project names in scanning announcements, the reassurance and review headings', async () => {
    const scan = deferred<RepoRulesScanResponse>();
    const harness = createHarness({ scan: () => scan.promise });
    const name = 'Confidential client merger';
    harness.render({ workspaces: [{ id: 'ws-1', name }] });
    await flush();
    const expectMaskedName = (minimum: number): void => {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      let count = 0;
      while (node) {
        if (node.textContent?.includes(name)) {
          count += 1;
          expect(
            node.parentElement?.closest(`.${REPLAY_MASK_CLASS}`),
          ).not.toBeNull();
        }
        node = walker.nextNode();
      }
      expect(count).toBeGreaterThanOrEqual(minimum);
    };
    expectMaskedName(1);
    await act(async () => {
      scan.resolve(scanResponse());
      await Promise.resolve();
    });
    await flush();
    expect(byTestId('repo-rules-reassurance')?.textContent).toContain(name);
    expectMaskedName(2);
  });

  it('keeps edits after a failed save, prevents double submits, and offers a rescan for stale reviews', async () => {
    let rejectApply: (error: Error) => void = () => undefined;
    const harness = createHarness({
      apply: () =>
        new Promise<RepoRulesStatus>((_, reject) => {
          rejectApply = reject;
        }),
    });
    const onClose = jest.fn();
    const onApplied = jest.fn();
    harness.render({ onClose, onApplied });
    await flush();
    click(toggles()[1] ?? null);
    click(byTestId('repo-rules-apply'));
    expect(byTestId('repo-rules-apply')?.hasAttribute('disabled')).toBe(true);
    click(byTestId('repo-rules-apply'));
    expect(harness.command).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectApply(new Error('The reviewed checkout changed. Scan again.'));
      await Promise.resolve();
    });
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(container.textContent).toContain('The reviewed checkout changed.');
    expect(toggles()[1]?.getAttribute('aria-checked')).toBe('true');

    click(byTestId('repo-rules-rescan'));
    await flush();
    expect(callsTo(harness, 'repoRules.scan')).toHaveLength(2);
    expect(toggles()[1]?.getAttribute('aria-checked')).toBe('true');
  });

  it('turns rules off from the review when they are already on', async () => {
    const harness = createHarness({
      status: { enabled: true, disabledRuleIds: ['x'], revision: 3 },
      apply: () => Promise.resolve({ ...DISABLED_STATUS, revision: 4 }),
    });
    harness.render();
    await flush();
    expect(byTestId('repo-rules-status-enabled')?.textContent).toBe(
      'Cursor rules are on for this project, with 1 rule turned off. Applies to new chats. Open chats keep their current rules.',
    );
    click(byTestId('repo-rules-turn-off'));
    await flush();
    expect(harness.command).toHaveBeenCalledTimes(1);
    expect(harness.command).toHaveBeenCalledWith('repoRules.apply', {
      workspaceId: 'ws-1',
      enabled: false,
    });
  });

  it('pluralizes the enabled notice', async () => {
    const harness = createHarness({
      status: { enabled: true, disabledRuleIds: ['x', 'y'], revision: 3 },
    });
    harness.render();
    await flush();
    expect(byTestId('repo-rules-status-enabled')?.textContent).toContain(
      'with 2 rules turned off.',
    );
  });

  it('turns rules off after a scan failure without enabling anything', async () => {
    const harness = createHarness({
      status: ENABLED_STATUS,
      scan: () => Promise.reject(new Error('This project has no checkout.')),
      apply: () => Promise.resolve(DISABLED_STATUS),
    });
    harness.render();
    await flush();
    click(byTestId('repo-rules-turn-off'));
    await flush();
    expect(harness.command.mock.calls).toEqual([
      ['repoRules.apply', { workspaceId: 'ws-1', enabled: false }],
    ]);
  });

  it('ignores a scan that finishes after the review closes', async () => {
    const scan = deferred<RepoRulesScanResponse>();
    createHarness({ scan: () => scan.promise }).render();
    expect(byTestId('repo-rules-scanning')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      scan.resolve(scanResponse());
      await Promise.resolve();
    });
    expect(container.textContent).toBe('');
  });

  it('scans again when the review reopens', async () => {
    const harness = createHarness();
    harness.render();
    await flush();
    act(() => root.unmount());
    root = createRoot(container);
    harness.render();
    await flush();
    expect(callsTo(harness, 'repoRules.scan')).toHaveLength(2);
    expect(byTestId('repo-rules-review-step')).not.toBeNull();
  });

  it.each(['success', 'failure'])(
    'ignores late scan and saved-status %s after unmount and reopening',
    async (outcome) => {
      const previousScan = deferred<RepoRulesScanResponse>();
      const previousStatus = deferred<RepoRulesStatus>();
      const currentStatus = deferred<RepoRulesStatus>();
      let scans = 0;
      let statuses = 0;
      const harness = createHarness({
        scan: () =>
          ++scans === 1
            ? previousScan.promise
            : Promise.resolve(scanResponse()),
        status: () =>
          ++statuses === 1 ? previousStatus.promise : currentStatus.promise,
      });
      harness.render();
      act(() => root.unmount());
      root = createRoot(container);
      harness.render();
      await flush();

      await act(async () => {
        if (outcome === 'success') {
          previousScan.resolve(scanResponse({ proposals: [] }));
          previousStatus.resolve(DISABLED_STATUS);
        } else {
          previousScan.reject(new Error('Previous scan failed'));
          previousStatus.reject(new Error('Previous status failed'));
        }
        await Promise.resolve();
      });
      await flush();
      expect(byTestId('repo-rules-scanning')).not.toBeNull();
      expect(byTestId('repo-rules-apply')).toBeNull();

      await act(async () => {
        currentStatus.resolve(ENABLED_STATUS);
        await Promise.resolve();
      });
      await flush();
      expect(byTestId('repo-rules-apply')?.textContent).toBe('Save');
      expect(byTestId('repo-rules-status-enabled')).not.toBeNull();
      expect(byTestId('repo-rules-status-error')).toBeNull();
      expect(byTestId('repo-rules-scan-error')).toBeNull();
      expect(callsTo(harness, 'repoRules.scan')).toHaveLength(2);
      expect(callsTo(harness, 'repoRules.status')).toHaveLength(2);
      expect(harness.command).not.toHaveBeenCalled();
    },
  );
});

describe('RepoRulesReview save result', () => {
  async function openReview(
    harness: Harness,
    props: Partial<RepoRulesReviewProps>,
  ): Promise<void> {
    harness.render(props);
    await flush();
    if (byTestId('repo-rules-choose-ws-1')) {
      click(byTestId('repo-rules-choose-ws-1'));
      await flush();
    }
    expect(byTestId('repo-rules-review-step')).not.toBeNull();
  }

  it('reports the default selection as the saved rule count', async () => {
    const onApplied = jest.fn<void, [AppliedResult]>();
    const onClose = jest.fn();
    const harness = createHarness();
    await openReview(harness, { onApplied, onClose });
    click(byTestId('repo-rules-apply'));
    await flush();
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'ws-1',
      status: { enabled: true },
      ruleCount: 1,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // The result is delivered before the modal closes.
    expect(onApplied.mock.invocationCallOrder[0]).toBeLessThan(
      onClose.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('reports zero rules when turning rules off', async () => {
    const onApplied = jest.fn<void, [AppliedResult]>();
    const harness = createHarness({
      status: { enabled: true, disabledRuleIds: [], revision: 3 },
      apply: () => Promise.resolve({ ...DISABLED_STATUS, revision: 4 }),
    });
    harness.render({ onApplied });
    await flush();
    click(byTestId('repo-rules-turn-off'));
    await flush();
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'ws-1',
      status: { enabled: false },
      ruleCount: 0,
    });
  });

  it('reports the submitted selection while edits are locked during a pending save', async () => {
    let finishApply: (status: RepoRulesStatus) => void = () => undefined;
    const harness = createHarness({
      apply: () =>
        new Promise((resolve) => {
          finishApply = resolve;
        }),
    });
    const onApplied = jest.fn<void, [AppliedResult]>();
    await openReview(harness, { onApplied, initialWorkspaceId: undefined });
    click(toggles()[1] ?? null);
    click(byTestId('repo-rules-apply'));
    expect(toggles().every((toggle) => toggle.disabled)).toBe(true);
    click(toggles()[0] ?? null);
    click(byTestId('repo-rules-apply'));
    expect(harness.command).toHaveBeenCalledTimes(1);
    expect(
      byTestId('repo-rules-change-project')?.hasAttribute('disabled'),
    ).toBe(true);
    harness.render({
      onApplied,
      initialWorkspaceId: undefined,
      workspaces: [{ id: 'ws-2', name: 'A different project' }],
    });
    expect(harness.command).toHaveBeenCalledWith('repoRules.apply', {
      workspaceId: 'ws-1',
      enabled: true,
      scanId: SCAN_ID,
      disabledRuleIds: [],
    });
    await act(async () => {
      finishApply({ ...DISABLED_STATUS, enabled: true, revision: 1 });
      await Promise.resolve();
    });
    await flush();
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'ws-1',
      ruleCount: 2,
    });
  });

  it('reports nothing for a failed save and once for a successful retry', async () => {
    let attempts = 0;
    const harness = createHarness({
      apply: () =>
        ++attempts === 1
          ? Promise.reject(new Error('Disk full.'))
          : Promise.resolve({ ...DISABLED_STATUS, enabled: true, revision: 1 }),
    });
    const onApplied = jest.fn<void, [AppliedResult]>();
    const onClose = jest.fn();
    await openReview(harness, { onApplied, onClose });
    click(byTestId('repo-rules-apply'));
    await flush();
    expect(container.textContent).toContain('Disk full.');
    expect(onApplied).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    click(byTestId('repo-rules-apply'));
    await flush();
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied.mock.calls[0]?.[0].ruleCount).toBe(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reports nothing when the save finishes after the review closes', async () => {
    let finishApply: (status: RepoRulesStatus) => void = () => undefined;
    const harness = createHarness({
      apply: () =>
        new Promise((resolve) => {
          finishApply = resolve;
        }),
    });
    const onApplied = jest.fn<void, [AppliedResult]>();
    const onClose = jest.fn();
    await openReview(harness, { onApplied, onClose });
    click(byTestId('repo-rules-apply'));
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      finishApply({ ...DISABLED_STATUS, enabled: true, revision: 1 });
      await Promise.resolve();
    });
    expect(onApplied).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still blocks saving an empty selection', async () => {
    const harness = createHarness();
    await openReview(harness, {});
    click(toggles()[0] ?? null);
    expect(byTestId('repo-rules-apply')?.textContent).toContain(
      'Turn on 0 rules',
    );
    expect(byTestId('repo-rules-apply')?.hasAttribute('disabled')).toBe(true);
  });
});

describe('RepoRulesReview multi-project offer (CAN-4980)', () => {
  type Decisions = Partial<Record<string, RepoRulesProjectDecision>>;

  /** A host that owns the decisions, like the desktop modal store. */
  function OfferHost({
    memberIds,
    onDecide,
    ...props
  }: Partial<RepoRulesReviewProps> & {
    readonly memberIds: readonly string[];
    readonly onDecide: jest.Mock<void, [string, RepoRulesProjectDecision]>;
  }): JSX.Element {
    const [decisions, setDecisions] = useState<Decisions>({});
    const latest = useRef<Decisions>({});
    return (
      <RepoRulesReview
        appName="Canopy"
        workspaces={[
          { id: 'ws-1', name: 'Alpha' },
          { id: 'ws-2', name: 'Beta' },
        ]}
        onClose={jest.fn()}
        {...props}
        offer={{
          decisions,
          onDecide: (workspaceId, decision) => {
            onDecide(workspaceId, decision);
            latest.current = { ...latest.current, [workspaceId]: decision };
            setDecisions(latest.current);
            return memberIds.every((id) => latest.current[id] !== undefined)
              ? 'close'
              : 'continue';
          },
        }}
      />
    );
  }

  function renderOffer(
    harness: Harness,
    props: Partial<RepoRulesReviewProps> = {},
    memberIds: readonly string[] = ['ws-1', 'ws-2'],
  ): {
    readonly onDecide: jest.Mock<void, [string, RepoRulesProjectDecision]>;
    readonly onApplied: jest.Mock<void, [AppliedResult]>;
    readonly onClose: jest.Mock;
  } {
    const onDecide = jest.fn<void, [string, RepoRulesProjectDecision]>();
    const onApplied = jest.fn<void, [AppliedResult]>();
    const onClose = jest.fn();
    act(() => {
      root.render(
        <CanopyClientProvider client={harness.client}>
          <OfferHost
            memberIds={memberIds}
            onDecide={onDecide}
            onApplied={onApplied}
            onClose={onClose}
            {...props}
          />
        </CanopyClientProvider>,
      );
    });
    return { onDecide, onApplied, onClose };
  }

  async function review(workspaceId: string): Promise<void> {
    click(byTestId(`repo-rules-choose-${workspaceId}`));
    await flush();
    expect(byTestId('repo-rules-review-step')).not.toBeNull();
  }

  function decisionLabel(workspaceId: string): string | null {
    return byTestId(`repo-rules-decision-${workspaceId}`)?.textContent ?? null;
  }

  function announcement(): string {
    return container.querySelector('[role="status"]')?.textContent ?? '';
  }

  it('returns to the chooser after the first apply and closes after the last', async () => {
    const harness = createHarness();
    const { onDecide, onApplied, onClose } = renderOffer(harness);
    await flush();
    await review('ws-1');
    click(byTestId('repo-rules-apply'));
    await flush();
    expect(onDecide.mock.calls).toEqual([['ws-1', 'on']]);
    expect(onApplied).toHaveBeenCalledTimes(1);
    // The decision is recorded before the save is reported.
    expect(onDecide.mock.invocationCallOrder[0]).toBeLessThan(
      onApplied.mock.invocationCallOrder[0] ?? 0,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(byTestId('repo-rules-choose')).not.toBeNull();
    expect(decisionLabel('ws-1')).toBe('Rules on');
    expect(byTestId('repo-rules-skip-ws-1')).toBeNull();
    expect(byTestId('repo-rules-skip-ws-2')).not.toBeNull();
    expect(announcement()).toBe('Rules on for Alpha');
    expect(document.activeElement?.textContent).toBe('Choose a project');
    expect(buttonNamed('Close')).not.toBeNull();

    await review('ws-2');
    click(byTestId('repo-rules-apply'));
    await flush();
    expect(onDecide.mock.calls).toEqual([
      ['ws-1', 'on'],
      ['ws-2', 'on'],
    ]);
    expect(onApplied).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('skips without any client call and closes once every project is decided', async () => {
    const harness = createHarness();
    const { onDecide, onClose } = renderOffer(harness);
    await flush();
    const skip = byTestId('repo-rules-skip-ws-1');
    expect(skip?.textContent).toBe('Skip Alpha');
    expect(skip?.querySelector(`.sr-only.${REPLAY_MASK_CLASS}`)).not.toBeNull();
    click(skip);
    expect(harness.query).not.toHaveBeenCalled();
    expect(harness.command).not.toHaveBeenCalled();
    expect(decisionLabel('ws-1')).toBe('Skipped');
    expect(announcement()).toBe('Skipped Alpha');
    expect(document.activeElement).toBe(byTestId('repo-rules-skip-ws-2'));
    expect(onClose).not.toHaveBeenCalled();
    click(byTestId('repo-rules-skip-ws-2'));
    expect(onDecide.mock.calls).toEqual([
      ['ws-1', 'skipped'],
      ['ws-2', 'skipped'],
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(harness.command).not.toHaveBeenCalled();
  });

  it.each<[string, readonly ['apply' | 'skip', 'apply' | 'skip']]>([
    ['apply then skip', ['apply', 'skip']],
    ['skip then apply', ['skip', 'apply']],
  ])('closes after %s', async (_label, steps) => {
    const harness = createHarness();
    const { onDecide, onClose } = renderOffer(harness);
    await flush();
    const ids: readonly string[] = ['ws-1', 'ws-2'];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const id = ids[index] ?? '';
      if (step === 'skip') {
        click(byTestId(`repo-rules-skip-${id}`));
      } else {
        await review(id);
        click(byTestId('repo-rules-apply'));
        await flush();
      }
      expect(onClose).toHaveBeenCalledTimes(index === 1 ? 1 : 0);
    }
    expect(onDecide).toHaveBeenCalledTimes(2);
  });

  it('records and announces an off decision as off', async () => {
    const harness = createHarness({
      status: ENABLED_STATUS,
      apply: () => Promise.resolve({ ...DISABLED_STATUS, revision: 3 }),
    });
    const { onDecide, onClose } = renderOffer(harness);
    await flush();
    await review('ws-1');
    click(byTestId('repo-rules-turn-off'));
    await flush();
    expect(onDecide.mock.calls).toEqual([['ws-1', 'off']]);
    expect(onClose).not.toHaveBeenCalled();
    expect(decisionLabel('ws-1')).toBe('Rules off');
    expect(announcement()).toBe('Rules off for Alpha');
    expect(announcement()).not.toContain('Rules on');
  });

  it('rescans a decided project on revisit and replaces its status only on a new save', async () => {
    let applied = 0;
    const harness = createHarness({
      apply: () =>
        Promise.resolve(
          applied++ === 0
            ? ENABLED_STATUS
            : { ...DISABLED_STATUS, revision: 3 },
        ),
      status: () =>
        Promise.resolve(applied > 0 ? ENABLED_STATUS : DISABLED_STATUS),
    });
    const { onDecide } = renderOffer(harness);
    await flush();
    await review('ws-1');
    click(byTestId('repo-rules-apply'));
    await flush();
    expect(decisionLabel('ws-1')).toBe('Rules on');
    await review('ws-1');
    expect(callsTo(harness, 'repoRules.scan')).toHaveLength(2);
    // Revisiting is not a decision.
    click(byTestId('repo-rules-change-project'));
    await flush();
    expect(decisionLabel('ws-1')).toBe('Rules on');
    await review('ws-1');
    click(byTestId('repo-rules-turn-off'));
    await flush();
    expect(decisionLabel('ws-1')).toBe('Rules off');
    expect(onDecide.mock.calls).toEqual([
      ['ws-1', 'on'],
      ['ws-1', 'off'],
    ]);
  });

  it('leaves a project undecided after a failed save and decides it on retry', async () => {
    let attempts = 0;
    const harness = createHarness({
      apply: () =>
        attempts++ === 0
          ? Promise.reject(new Error('Disk full.'))
          : Promise.resolve(ENABLED_STATUS),
    });
    const { onDecide, onApplied } = renderOffer(harness);
    await flush();
    await review('ws-1');
    click(byTestId('repo-rules-apply'));
    await flush();
    expect(onDecide).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(byTestId('repo-rules-review-step')).not.toBeNull();
    click(byTestId('repo-rules-apply'));
    await flush();
    expect(onDecide.mock.calls).toEqual([['ws-1', 'on']]);
  });

  it('records nothing for a save that finishes after the review closes', async () => {
    const apply = deferred<RepoRulesStatus>();
    const harness = createHarness({ apply: () => apply.promise });
    const { onDecide, onApplied, onClose } = renderOffer(harness);
    await flush();
    await review('ws-1');
    click(byTestId('repo-rules-apply'));
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      apply.resolve(ENABLED_STATUS);
      await Promise.resolve();
    });
    expect(onDecide).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('records nothing for a save from a project the user left', async () => {
    const apply = deferred<RepoRulesStatus>();
    const harness = createHarness({ apply: () => apply.promise });
    const { onDecide } = renderOffer(harness, { initialWorkspaceId: 'ws-1' });
    await flush();
    click(byTestId('repo-rules-apply'));
    renderOffer(harness, { initialWorkspaceId: 'ws-2' });
    await flush();
    await act(async () => {
      apply.resolve(ENABLED_STATUS);
      await Promise.resolve();
    });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('shows a closing empty state when no offered project remains', async () => {
    const harness = createHarness();
    const { onClose } = renderOffer(harness, { workspaces: [] });
    await flush();
    expect(byTestId('repo-rules-choose')?.textContent).toContain(
      'These projects are no longer available.',
    );
    click(buttonNamed('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(harness.query).not.toHaveBeenCalled();
  });

  it('uses the current offer callbacks when membership grows during an apply', async () => {
    const pending = deferred<RepoRulesStatus>();
    const harness = createHarness({ apply: () => pending.promise });
    const earlier = renderOffer(harness, { initialWorkspaceId: 'ws-1' }, [
      'ws-1',
    ]);
    await flush();
    click(byTestId('repo-rules-apply'));
    const current = renderOffer(harness, { initialWorkspaceId: 'ws-1' });
    await act(async () => {
      pending.resolve(ENABLED_STATUS);
      await Promise.resolve();
    });
    await flush();
    expect(earlier.onDecide).not.toHaveBeenCalled();
    expect(earlier.onClose).not.toHaveBeenCalled();
    expect(current.onDecide).toHaveBeenCalledWith('ws-1', 'on');
    expect(current.onClose).not.toHaveBeenCalled();
    expect(byTestId('repo-rules-choose')).not.toBeNull();
  });

  it('ignores an apply result after its offered project is removed', async () => {
    const pending = deferred<RepoRulesStatus>();
    const harness = createHarness({ apply: () => pending.promise });
    const earlier = renderOffer(harness, { initialWorkspaceId: 'ws-1' });
    await flush();
    click(byTestId('repo-rules-apply'));
    const current = renderOffer(
      harness,
      {
        initialWorkspaceId: 'ws-1',
        workspaces: [{ id: 'ws-2', name: 'Beta' }],
      },
      ['ws-2'],
    );
    await act(async () => {
      pending.resolve(ENABLED_STATUS);
      await Promise.resolve();
    });
    await flush();
    expect(earlier.onDecide).not.toHaveBeenCalled();
    expect(current.onDecide).not.toHaveBeenCalled();
    expect(current.onClose).not.toHaveBeenCalled();
    expect(byTestId('repo-rules-choose')).not.toBeNull();
  });

  it('locks apply synchronously before React processes duplicate clicks', async () => {
    const pending = deferred<RepoRulesStatus>();
    const harness = createHarness({ apply: () => pending.promise });
    const { onDecide } = renderOffer(harness, { initialWorkspaceId: 'ws-1' });
    await flush();
    const button = byTestId('repo-rules-apply');
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(harness.command).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(ENABLED_STATUS);
      await Promise.resolve();
    });
    await flush();
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it('records a Skip once even when clicks arrive before the host rerenders', async () => {
    const harness = createHarness();
    const { onDecide } = renderOffer(harness);
    await flush();
    const skip = byTestId('repo-rules-skip-ws-1');
    act(() => {
      skip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      skip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(harness.command).not.toHaveBeenCalled();
  });

  it('keeps the plain chooser without an offer', async () => {
    const harness = createHarness();
    harness.render({ initialWorkspaceId: undefined });
    await flush();
    expect(byTestId('repo-rules-skip-ws-1')).toBeNull();
    expect(byTestId('repo-rules-decision-ws-1')).toBeNull();
    expect(buttonNamed('Cancel')).not.toBeNull();
  });
});
