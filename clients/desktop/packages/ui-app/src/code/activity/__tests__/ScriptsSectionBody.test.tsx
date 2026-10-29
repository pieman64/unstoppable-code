/** @jest-environment jsdom */
import { act } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ScriptsSectionBody,
  type ScriptsSectionEntry,
  type ScriptsSectionRun,
} from '../scripts/ScriptsSectionBody';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const ENTRIES: readonly ScriptsSectionEntry[] = [
  {
    script: {
      scriptKey: 'workspace-repo:web:build',
      scriptName: 'build',
      displayName: 'Build',
      label: 'Web App — Build',
      command: 'npm run build',
      lifecycle: 'custom',
      target: 'workspace-repo',
      repoId: 'web',
      repoName: 'Web App',
    },
    confirmBeforeRun: true,
    runDisabled: false,
  },
  {
    script: {
      scriptKey: 'workspace-repo:web:test',
      scriptName: 'test',
      displayName: 'Test',
      label: 'Web App — Test',
      command: 'npm test',
      lifecycle: 'custom',
      target: 'workspace-repo',
      repoId: 'web',
      repoName: 'Web App',
    },
    confirmBeforeRun: true,
    runDisabled: false,
  },
];

const COMPLETED_RUN: ScriptsSectionRun = {
  scriptKey: 'workspace-repo:web:build',
  label: 'Web App — Build',
  status: 'success',
  outputLines: ['build complete'],
  exitCode: 0,
  timedOut: false,
  durationMs: 1200,
  startedAt: 100,
  hasDevServerHits: false,
};

describe('ScriptsSectionBody', () => {
  it('shows a confirmed start refusal as Failed to start in the completed card and logs', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const run: ScriptsSectionRun = {
      ...COMPLETED_RUN,
      status: 'failed',
      exitCode: null,
      startError: 'Setup configuration is invalid.',
      outputLines: ['Setup configuration is invalid.'],
    };
    act(() =>
      root.render(
        <ScriptsSectionBody
          identityKey="start-refusal"
          entries={ENTRIES}
          runs={{ [run.scriptKey]: run }}
          onRun={() => Promise.resolve()}
          onStop={jest.fn()}
        />,
      ),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="activity-scripts-completed-toggle"]',
        )
        ?.click(),
    );
    expect(container.textContent).toContain('Failed to start');
    expect(container.textContent).not.toContain('Stopped');
    const completed = container.querySelector('[aria-label="Enlarge output"]');
    expect(
      completed?.closest('.border-fg-destructive-strong\\/20'),
    ).not.toBeNull();
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Enlarge output"]')
        ?.click(),
    );
    expect(document.body.textContent).toContain(
      'Setup configuration is invalid.',
    );
    expect(document.body.textContent).toContain('Failed to start');
    act(() => root.unmount());
    container.remove();
  });

  it('groups repo entries, confirms runs, and expands completed cards', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onRun = jest.fn<Promise<void>, [ScriptsSectionEntry]>(() =>
      Promise.resolve(),
    );

    act(() => {
      root.render(
        <ScriptsSectionBody
          identityKey="workspace/worktree"
          entries={ENTRIES}
          runs={{ 'workspace-repo:web:build': COMPLETED_RUN }}
          onRun={onRun}
          onStop={jest.fn()}
          renderSourceInfoButton={(): null => null}
          renderWorkspaceLifecycleInfoButton={(): null => null}
          renderDevServerControl={(): null => null}
          renderOutputModal={(): null => null}
        />,
      );
    });

    const repoToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-scripts-repo-toggle"]',
    );
    expect(repoToggle?.textContent).toContain('Web App');
    expect(repoToggle?.textContent).toContain('2 scripts');
    act(() => repoToggle?.click());

    const runButtons = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="activity-scripts-run"]',
    );
    act(() => runButtons[0]?.click());
    expect(container.textContent).toContain('Run Build?');
    // The confirmation shows the command line, which replay blocks.
    const command = Array.from(container.querySelectorAll('pre')).find(
      (node) => node.textContent === 'npm run build',
    );
    expect(command?.closest('.ph-no-capture')).not.toBeNull();
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Confirm',
    );
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
    });
    expect(onRun).toHaveBeenCalledWith(ENTRIES[0]);

    const completedToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-scripts-completed-toggle"]',
    );
    act(() => completedToggle?.click());
    expect(container.textContent).toContain('Success · 1s');

    act(() => root.unmount());
    container.remove();
  });

  it('auto-expands a running repo and routes its stop action', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onStop = jest.fn();
    const running: ScriptsSectionRun = {
      ...COMPLETED_RUN,
      status: 'running',
      outputLines: Array.from({ length: 20 }, (_, index) => `line ${index}`),
      hasDevServerHits: true,
    };

    act(() => {
      root.render(
        <ScriptsSectionBody
          identityKey="workspace/worktree"
          entries={ENTRIES}
          runs={{ 'workspace-repo:web:build': running }}
          onRun={() => Promise.resolve()}
          onStop={onStop}
          renderSourceInfoButton={(): null => null}
          renderWorkspaceLifecycleInfoButton={(): null => null}
          renderDevServerControl={(): JSX.Element => (
            <button type="button">Open server</button>
          )}
          renderOutputModal={(): null => null}
        />,
      );
    });

    const repoToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-scripts-repo-toggle"]',
    );
    expect(repoToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Open server');
    const stop = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-scripts-stop"]',
    );
    act(() => stop?.click());
    expect(onStop).toHaveBeenCalledWith('workspace-repo:web:build');

    act(() => root.unmount());
    container.remove();
  });

  it('omits unavailable host controls and empty confirmation details', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const entry: ScriptsSectionEntry = {
      ...ENTRIES[0],
      script: { ...ENTRIES[0].script, command: '' },
    };

    act(() => {
      root.render(
        <ScriptsSectionBody
          identityKey="portal/worktree"
          entries={[entry]}
          runs={{}}
          onRun={() => Promise.resolve()}
          groupWorkspaceLifecycles={false}
        />,
      );
    });

    const run = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-scripts-run"]',
    );
    act(() => run?.click());
    expect(container.textContent).toContain('Run Web App — Build?');
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('[aria-label="Enlarge output"]')).toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('uses terminal icons that distinguish default and interactive scripts', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <ScriptsSectionBody
          identityKey="workspace/worktree"
          entries={[ENTRIES[0]]}
          runs={{}}
          onRun={() => Promise.resolve()}
          groupWorkspaceLifecycles={false}
        />,
      );
    });

    let run = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-scripts-run"]',
    );
    expect(run?.getAttribute('data-execution-action-button')).toBe('true');
    expect(
      run?.querySelector('[data-testid="default-script-icon"]'),
    ).not.toBeNull();
    expect(
      run?.querySelector('[data-testid="interactive-script-icon"]'),
    ).toBeNull();

    const interactive: ScriptsSectionEntry = {
      ...ENTRIES[0],
      script: { ...ENTRIES[0].script, interactive: true },
    };
    act(() => {
      root.render(
        <ScriptsSectionBody
          identityKey="workspace/worktree"
          entries={[interactive]}
          runs={{}}
          onRun={() => Promise.resolve()}
          groupWorkspaceLifecycles={false}
        />,
      );
    });
    run = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-scripts-run"]',
    );
    expect(
      run?.querySelector('[data-testid="interactive-script-icon"]'),
    ).not.toBeNull();
    expect(
      run?.querySelector('[data-testid="default-script-icon"]'),
    ).toBeNull();
    expect(run?.getAttribute('aria-label')).toBe(
      'Run Web App — Build in terminal',
    );

    act(() => root.unmount());
    container.remove();
  });
});
