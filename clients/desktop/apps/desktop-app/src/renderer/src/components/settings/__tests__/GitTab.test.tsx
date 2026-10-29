/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GitExecutableStatus } from '@canopy/desktop-shared/types';
import {
  GitHubUsernamePrefixOption,
  MergeQueueSettingsSection,
  WindowsGitExecutableSection,
} from '../GitTab';
import { outermostReplayBlock } from '@/test-utils/replay';
import { createGitTabFailedLoadPreferences } from '../git-tab-fallback-preferences';

jest.mock('../SettingsPluginPicker', () => ({
  SettingsPluginPicker: (): null => null,
}));

function makeStatus(
  overrides: Partial<GitExecutableStatus> = {},
): GitExecutableStatus {
  return {
    platform: 'win32',
    required: true,
    ready: false,
    path: null,
    version: null,
    source: 'not-found',
    wingetAvailable: true,
    checkedAt: '2026-06-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('WindowsGitExecutableSection', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    window,
    'platform',
  );
  const getGitExecutableStatus = jest.fn<Promise<GitExecutableStatus>, []>();
  const redetectGitExecutable = jest.fn<Promise<GitExecutableStatus>, []>();
  const browseGitExecutable = jest.fn<Promise<GitExecutableStatus>, []>();

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: platform,
    });
  }

  beforeEach(() => {
    getGitExecutableStatus.mockReset();
    redetectGitExecutable.mockReset();
    browseGitExecutable.mockReset();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getGitExecutableStatus,
        redetectGitExecutable,
        browseGitExecutable,
      },
    });
  });

  afterEach(() => {
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(window, 'platform', originalPlatformDescriptor);
    } else {
      Reflect.deleteProperty(window, 'platform');
    }
  });

  async function mount(): Promise<{
    container: HTMLElement;
    cleanup: () => void;
  }> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container);
      root.render(<WindowsGitExecutableSection />);
      await Promise.resolve();
    });
    return {
      container,
      cleanup: (): void => {
        act(() => {
          root?.unmount();
        });
        container.remove();
      },
    };
  }

  it('renders nothing on Linux', async () => {
    setPlatform('linux');
    getGitExecutableStatus.mockResolvedValue(makeStatus());
    const { container, cleanup } = await mount();
    try {
      expect(
        container.querySelector(
          '[data-testid="settings-git-executable-section"]',
        ),
      ).toBeNull();
      expect(getGitExecutableStatus).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('shows the detected path and version on Windows', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(
      makeStatus({
        ready: true,
        path: 'C:\\Program Files\\Git\\cmd\\git.exe',
        version: 'git version 2.45.0',
        source: 'auto-detected',
      }),
    );
    const { container, cleanup } = await mount();
    try {
      expect(
        container.querySelector(
          '[data-testid="settings-git-executable-section"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="settings-git-executable-path"]')
          ?.textContent,
      ).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
      expect(
        container.querySelector(
          '[data-testid="settings-git-executable-status"]',
        )?.textContent,
      ).toBe('Git 2.45.0');
    } finally {
      cleanup();
    }
  });

  it('shows the not-detected state when no Git executable is known', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(makeStatus({ path: null }));
    const { container, cleanup } = await mount();
    try {
      expect(
        container.querySelector('[data-testid="settings-git-executable-path"]')
          ?.textContent,
      ).toBe('No Git executable detected');
    } finally {
      cleanup();
    }
  });

  it('updates the path and message after a successful Redetect', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(makeStatus({ path: null }));
    redetectGitExecutable.mockResolvedValue(
      makeStatus({
        ready: true,
        path: 'C:\\Git\\git.exe',
        version: '2.46.0',
        source: 'auto-detected',
      }),
    );
    const { container, cleanup } = await mount();
    try {
      const redetect = container.querySelector(
        '[data-testid="settings-git-executable-redetect"]',
      );
      await act(async () => {
        (redetect as HTMLButtonElement).click();
        await Promise.resolve();
      });
      expect(redetectGitExecutable).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector('[data-testid="settings-git-executable-path"]')
          ?.textContent,
      ).toBe('C:\\Git\\git.exe');
      expect(
        container.querySelector(
          '[data-testid="settings-git-executable-message"]',
        )?.textContent,
      ).toBe('Git was detected at C:\\Git\\git.exe.');
    } finally {
      cleanup();
    }
  });

  it('reports failure when Redetect finds no valid Git', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(makeStatus({ path: null }));
    redetectGitExecutable.mockResolvedValue(makeStatus({ ready: false }));
    const { container, cleanup } = await mount();
    try {
      await act(async () => {
        (
          container.querySelector(
            '[data-testid="settings-git-executable-redetect"]',
          ) as HTMLButtonElement
        ).click();
        await Promise.resolve();
      });
      expect(
        container.querySelector(
          '[data-testid="settings-git-executable-message"]',
        )?.textContent,
      ).toBe('No valid Git installation was detected.');
    } finally {
      cleanup();
    }
  });

  it('confirms a valid Browse selection', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(makeStatus({ path: null }));
    browseGitExecutable.mockResolvedValue(
      makeStatus({
        ready: true,
        path: 'D:\\tools\\git\\git.exe',
        version: '2.45.0',
        source: 'browse',
      }),
    );
    const { container, cleanup } = await mount();
    try {
      await act(async () => {
        (
          container.querySelector(
            '[data-testid="settings-git-executable-browse"]',
          ) as HTMLButtonElement
        ).click();
        await Promise.resolve();
      });
      expect(browseGitExecutable).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector(
          '[data-testid="settings-git-executable-message"]',
        )?.textContent,
      ).toBe('Git was detected at D:\\tools\\git\\git.exe.');
    } finally {
      cleanup();
    }
  });

  it('rejects an invalid Browse selection with the validation message', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(makeStatus({ path: null }));
    browseGitExecutable.mockResolvedValue(
      makeStatus({
        ready: false,
        path: 'D:\\tools\\notgit.exe',
        error: 'Selected file is not a Git executable.',
        source: 'browse',
      }),
    );
    const { container, cleanup } = await mount();
    try {
      await act(async () => {
        (
          container.querySelector(
            '[data-testid="settings-git-executable-browse"]',
          ) as HTMLButtonElement
        ).click();
        await Promise.resolve();
      });
      expect(
        container.querySelector(
          '[data-testid="settings-git-executable-message"]',
        )?.textContent,
      ).toBe(
        'Select a valid git.exe file. Selected file is not a Git executable.',
      );
    } finally {
      cleanup();
    }
  });

  it('includes validation detail when Browse rejects', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(makeStatus({ path: null }));
    browseGitExecutable.mockRejectedValue(
      new Error('Selected file must be git.exe'),
    );
    const { container, cleanup } = await mount();
    try {
      await act(async () => {
        (
          container.querySelector(
            '[data-testid="settings-git-executable-browse"]',
          ) as HTMLButtonElement
        ).click();
        await Promise.resolve();
      });
      expect(
        container.querySelector(
          '[data-testid="settings-git-executable-message"]',
        )?.textContent,
      ).toBe('Select a valid git.exe file. Selected file must be git.exe');
    } finally {
      cleanup();
    }
  });
});

describe('createGitTabFailedLoadPreferences', () => {
  it('seeds Full Access approval defaults on every surface', () => {
    // CAN-3055: this is the `.catch()` seed for a failed `loadPreferences()`.
    // It is display state while main keeps enforcing Full Access, so showing
    // Ask here would understate what agents are actually allowed to do.
    expect(createGitTabFailedLoadPreferences().approvalDefaults).toEqual({
      worktree: 'full-access',
      cowork: 'full-access',
      appAdvisor: 'full-access',
    });
  });

  it('seeds the default merge queue agent handling', () => {
    expect(createGitTabFailedLoadPreferences().mergeQueueAgentHandling).toBe(
      'when_hook_absent',
    );
  });

  it('seeds the approvals upgrade notice as not dismissed', () => {
    // Display-state only. `GitTab.save()` persists just the changed patch, so
    // this value never reaches disk and cannot re-arm the notice on its own --
    // it only keeps the failed-load render consistent with the product
    // default, which is likewise not dismissed for a fresh profile.
    expect(
      createGitTabFailedLoadPreferences().approvalsUpgradeNoticeDismissed,
    ).toBe(false);
  });
});

describe('MergeQueueSettingsSection', () => {
  async function mount(
    handling: 'always' | 'when_hook_absent' | 'never',
    onChange = jest.fn(),
  ): Promise<{ container: HTMLElement; cleanup: () => void }> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MergeQueueSettingsSection handling={handling} onChange={onChange} />,
      );
      await Promise.resolve();
    });
    return {
      container,
      cleanup: (): void => {
        act(() => {
          root?.unmount();
        });
        container.remove();
      },
    };
  }

  function radio(container: HTMLElement, value: string): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(
      `input[type="radio"][value="${value}"]`,
    );
    if (!input) throw new Error(`Missing ${value} option`);
    return input;
  }

  it('offers the three eviction handling choices under a Merge queue heading', async () => {
    const { container, cleanup } = await mount('when_hook_absent');
    try {
      expect(container.querySelector('h2')?.textContent).toBe('Merge queue');
      expect(container.textContent).toContain(
        "Applies when a pull request's base branch uses a GitHub merge queue.",
      );
      const group = container.querySelector('[role="radiogroup"]');
      expect(group?.getAttribute('aria-label')).toBe(
        'Agent merge queue eviction handling',
      );
      expect(
        Array.from(
          container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
        ).map((input) => [input.value, input.checked]),
      ).toEqual([
        ['always', false],
        ['when_hook_absent', true],
        ['never', false],
      ]);
      expect(container.textContent).toContain('When project hook is absent');
      expect(container.textContent).toContain(
        'Merge starts an agent chat unless the project has a "PR Removed From Merge Queue" hook that isn\'t paused in the worktree.',
      );
    } finally {
      cleanup();
    }
  });

  it('recommends the project hook and the built-in merge-pr skill', async () => {
    const { container, cleanup } = await mount('never');
    try {
      const tip = container.querySelector(
        '[data-testid="settings-git-merge-queue-tip"]',
      );
      expect(tip?.textContent).toContain('Tip');
      expect(tip?.textContent).toContain(
        'Set up a "PR Removed From Merge Queue" hook in your project so agents handle evictions.',
      );
      expect(
        Array.from(tip?.querySelectorAll('code') ?? []).map(
          (code) => code.textContent,
        ),
      ).toEqual(['merge-pr', 'builtin-gh']);
    } finally {
      cleanup();
    }
  });

  it('reports the chosen handling', async () => {
    const onChange = jest.fn();
    const { container, cleanup } = await mount('when_hook_absent', onChange);
    try {
      act(() => {
        radio(container, 'never').click();
      });
      expect(onChange).toHaveBeenCalledWith('never');
    } finally {
      cleanup();
    }
  });
});

describe('GitHubUsernamePrefixOption', () => {
  function renderOption(username: string | null): HTMLOptionElement | null {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <select>
          <GitHubUsernamePrefixOption username={username} />
        </select>,
      );
    });
    return container.querySelector('option');
  }

  it('blocks the option naming the GitHub login from session replay', () => {
    const option = renderOption('octo-ada');
    expect(option?.textContent).toBe('GitHub username (octo-ada)');
    expect(outermostReplayBlock(option)).toBe(option);
    expect(outermostReplayBlock(option?.parentElement)).toBeNull();
  });

  it('records the option when no login is known', () => {
    const option = renderOption(null);
    expect(option?.textContent).toBe('GitHub username');
    expect(outermostReplayBlock(option)).toBeNull();
  });
});
