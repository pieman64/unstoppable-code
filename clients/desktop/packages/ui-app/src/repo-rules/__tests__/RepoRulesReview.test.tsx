/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities, CanopyClient } from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type {
  RepoRuleProposal,
  RepoRulesScanResponse,
  RepoRulesStatus,
} from '@canopy/protocol/repo-rules';
import { RepoRulesReview, type RepoRulesReviewProps } from '../RepoRulesReview';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const BASE_CAPABILITIES: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
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

const DISABLED_STATUS: RepoRulesStatus = {
  enabled: false,
  disabledRuleIds: [],
  revision: 0,
};

interface Harness {
  readonly query: jest.Mock<Promise<unknown>, [name: string]>;
  readonly command: jest.Mock;
  render(props?: Partial<RepoRulesReviewProps>): void;
}

let container: HTMLDivElement;
let root: Root;

function createHarness(
  options: {
    readonly repoRulesImport?: boolean;
    readonly status?: RepoRulesStatus;
    readonly scan?: () => Promise<RepoRulesScanResponse>;
    readonly apply?: () => Promise<RepoRulesStatus>;
    readonly preview?: () => Promise<{ body: string }>;
  } = {},
): Harness {
  const query = jest.fn((name: string): Promise<unknown> => {
    switch (name) {
      case 'repoRules.status':
        return Promise.resolve(options.status ?? DISABLED_STATUS);
      case 'repoRules.scan':
        return options.scan ? options.scan() : Promise.resolve(scanResponse());
      case 'repoRules.preview':
        return options.preview
          ? options.preview()
          : Promise.resolve({ body: '<b>Use tabs</b>' });
      default:
        return Promise.reject(new Error(`unexpected ${name}`));
    }
  });
  const command = jest.fn(() =>
    options.apply
      ? options.apply()
      : Promise.resolve({ ...DISABLED_STATUS, enabled: true, revision: 1 }),
  );
  const client: CanopyClient = {
    capabilities: {
      ...BASE_CAPABILITIES,
      ...(options.repoRulesImport === false ? {} : { repoRulesImport: true }),
    },
    query,
    command,
    subscribe: () => () => undefined,
  };
  return {
    query,
    command,
    render(props = {}): void {
      act(() => {
        root.render(
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
          </CanopyClientProvider>,
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

function toggles(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="repo-rules-rule-toggle"]',
    ),
  );
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
  it('resets consent and ignores late scans when the requested workspace changes', async () => {
    let finishScan: (value: RepoRulesScanResponse) => void = () => undefined;
    const harness = createHarness({
      scan: () =>
        new Promise((resolve) => {
          finishScan = resolve;
        }),
    });
    harness.render();
    await flush();
    click(byTestId('repo-rules-scan'));
    harness.render({ initialWorkspaceId: 'ws-2' });
    await flush();
    expect(byTestId('repo-rules-consent')?.textContent).toContain('Beta');
    await act(async () => {
      finishScan(scanResponse());
      await Promise.resolve();
    });
    expect(byTestId('repo-rules-review-step')).toBeNull();
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
    click(byTestId('repo-rules-scan'));
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
    click(byTestId('repo-rules-scan'));
    await flush();
    const text = byTestId('repo-rules-review-step')?.textContent;
    expect(text).toContain('Before working in this folder');
    expect(text).toContain('explicitly mention');
    expect(text).toContain(
      'Files read through rule entries or @file references remain live',
    );
  });
  it('renders the unsupported state and makes no client calls without the capability', () => {
    const harness = createHarness({ repoRulesImport: false });
    harness.render();
    expect(byTestId('repo-rules-unsupported')).not.toBeNull();
    expect(harness.query).not.toHaveBeenCalled();
    expect(harness.command).not.toHaveBeenCalled();
  });

  it('asks for consent before scanning, reading only the saved status', async () => {
    const harness = createHarness();
    harness.render();
    await flush();
    expect(byTestId('repo-rules-consent')?.textContent).toContain(
      'AGENTS.md and CLAUDE.md',
    );
    expect(harness.query.mock.calls.map(([name]) => name)).toEqual([
      'repoRules.status',
    ]);
    click(byTestId('repo-rules-scan'));
    await flush();
    expect(harness.query).toHaveBeenCalledWith('repoRules.scan', {
      workspaceId: 'ws-1',
    });
    expect(byTestId('repo-rules-review-step')).not.toBeNull();
  });

  it('asks the user to choose a project when the entry point has none', async () => {
    const harness = createHarness();
    harness.render({ initialWorkspaceId: undefined });
    await flush();
    expect(byTestId('repo-rules-choose')).not.toBeNull();
    expect(harness.query).not.toHaveBeenCalled();
    click(byTestId('repo-rules-choose-ws-2'));
    await flush();
    expect(harness.query).toHaveBeenCalledWith('repoRules.status', {
      workspaceId: 'ws-2',
    });
    expect(byTestId('repo-rules-consent')?.textContent).toContain('Beta');
  });

  it('keeps backend selection defaults, lists skipped files without toggles, and applies the unselected ids', async () => {
    const onApplied = jest.fn<
      void,
      [{ readonly workspaceId: string; readonly status: RepoRulesStatus }]
    >();
    const onClose = jest.fn();
    const harness = createHarness();
    harness.render({ onApplied, onClose });
    await flush();
    click(byTestId('repo-rules-scan'));
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
    expect(onClose).toHaveBeenCalled();
  });

  it('renders previews as text and blocks them from session replay', async () => {
    const harness = createHarness();
    harness.render();
    await flush();
    click(byTestId('repo-rules-scan'));
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

  it('masks project names in consent, scanning announcements and review headings', async () => {
    let finishScan: (value: RepoRulesScanResponse) => void = () => undefined;
    const harness = createHarness({
      scan: () =>
        new Promise((resolve) => {
          finishScan = resolve;
        }),
    });
    const name = 'Confidential client merger';
    harness.render({ workspaces: [{ id: 'ws-1', name }] });
    await flush();
    const expectMaskedName = (): void => {
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
      expect(count).toBeGreaterThan(0);
    };
    expectMaskedName();
    click(byTestId('repo-rules-scan'));
    expectMaskedName();
    await act(async () => {
      finishScan(scanResponse());
      await Promise.resolve();
    });
    await flush();
    expectMaskedName();
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
    harness.render({ onClose });
    await flush();
    click(byTestId('repo-rules-scan'));
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
    expect(container.textContent).toContain('The reviewed checkout changed.');
    expect(toggles()[1]?.getAttribute('aria-checked')).toBe('true');

    click(byTestId('repo-rules-rescan'));
    await flush();
    expect(
      harness.query.mock.calls.filter(([name]) => name === 'repoRules.scan'),
    ).toHaveLength(2);
    expect(toggles()[1]?.getAttribute('aria-checked')).toBe('true');
  });

  it('turns rules off without a scan when they are already on', async () => {
    const harness = createHarness({
      status: { enabled: true, disabledRuleIds: ['x'], revision: 3 },
      apply: () => Promise.resolve({ ...DISABLED_STATUS, revision: 4 }),
    });
    harness.render();
    await flush();
    expect(byTestId('repo-rules-status-enabled')?.textContent).toContain(
      '1 rule turned off',
    );
    click(byTestId('repo-rules-turn-off'));
    await flush();
    expect(harness.command).toHaveBeenCalledWith('repoRules.apply', {
      workspaceId: 'ws-1',
      enabled: false,
    });
    expect(
      harness.query.mock.calls.some(([name]) => name === 'repoRules.scan'),
    ).toBe(false);
  });

  it('shows an empty state and a scan error with retry', async () => {
    let fail = true;
    const harness = createHarness({
      scan: () =>
        fail
          ? Promise.reject(new Error('This project has no checkout.'))
          : Promise.resolve(scanResponse({ proposals: [], skipped: [] })),
    });
    harness.render();
    await flush();
    click(byTestId('repo-rules-scan'));
    await flush();
    expect(byTestId('repo-rules-scan-error')?.textContent).toContain(
      'This project has no checkout.',
    );
    fail = false;
    click(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Try again',
      ) ?? null,
    );
    await flush();
    expect(byTestId('repo-rules-empty')).not.toBeNull();
    expect(byTestId('repo-rules-apply')).toBeNull();
  });

  it('ignores a scan that finishes after the review closes', async () => {
    let resolveScan: (scan: RepoRulesScanResponse) => void = () => undefined;
    const harness = createHarness({
      scan: () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        }),
    });
    harness.render();
    await flush();
    click(byTestId('repo-rules-scan'));
    expect(byTestId('repo-rules-scanning')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      resolveScan(scanResponse());
      await Promise.resolve();
    });
    expect(container.textContent).toBe('');
  });
});
