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
  BranchNamePrefixSelect,
  MergeQueueSettingsSection,
  WindowsGitExecutableSection,
} from '../GitTab';
import { outermostReplayBlock } from '@/test-utils/replay';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { settingsSelectTrigger } from '@canopy/ui-app/settings/__tests__/helpers/settings-select';
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
  const openExternal = jest.fn<Promise<void>, [{ url: string }]>();

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
    openExternal.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getGitExecutableStatus,
        redetectGitExecutable,
        browseGitExecutable,
        browser: { openExternal },
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

  it('shows Linux executable status using the same Git query', async () => {
    setPlatform('linux');
    getGitExecutableStatus.mockResolvedValue(makeStatus());
    const { container, cleanup } = await mount();
    try {
      expect(
        container.querySelector(
          '[data-testid="settings-git-executable-section"]',
        ),
      ).not.toBeNull();
      expect(getGitExecutableStatus).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('offers branded Ubuntu install guidance when Linux Git is unusable and hides it after recovery', async () => {
    setPlatform('linux');
    getGitExecutableStatus.mockResolvedValue(
      makeStatus({
        platform: 'linux',
        error: 'Selected Git executable cannot be used.',
      }),
    );
    redetectGitExecutable.mockResolvedValue(
      makeStatus({ platform: 'linux', ready: true, path: '/usr/bin/git' }),
    );
    const { container, cleanup } = await mount();
    try {
      const guidance = container.querySelector(
        '[data-testid="git-gate-install-explanation"]',
      );
      expect(guidance?.textContent).toContain('Ubuntu');
      expect(guidance?.textContent).toContain('sudo apt install git');
      expect(guidance?.textContent).toContain('Redetect');
      const instructions = container.querySelector(
        '[data-testid="git-gate-manual"]',
      );
      if (!(instructions instanceof HTMLButtonElement))
        throw new Error('Missing installation instructions');
      await act(async () => {
        instructions.click();
        await Promise.resolve();
      });
      expect(openExternal).toHaveBeenCalledWith({
        url: 'https://git-scm.com/install/linux',
      });
      const redetect = container.querySelector(
        '[data-testid="settings-git-executable-redetect"]',
      );
      if (!(redetect instanceof HTMLButtonElement))
        throw new Error('Missing Redetect');
      await act(async () => {
        redetect.click();
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="git-gate-install-explanation"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="git-gate-manual"]'),
      ).toBeNull();
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

describe('BranchNamePrefixSelect', () => {
  function renderSelect(username: string | null): HTMLButtonElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <BranchNamePrefixSelect
          username={username}
          value="github"
          onValueChange={() => undefined}
        />,
      );
    });
    return settingsSelectTrigger(container, 'button[role="combobox"]');
  }

  /** The open menu, which renders outside the page. */
  function menu(trigger: HTMLButtonElement): HTMLElement | null {
    act(() => trigger.click());
    const listId = trigger.getAttribute('aria-controls');
    return listId ? document.getElementById(listId) : null;
  }

  it('blocks only the label text naming the GitHub login from session replay', () => {
    const trigger = renderSelect('octo-ada');
    expect(trigger.textContent).toBe('GitHub username (octo-ada)');
    // The control itself stays recorded; only the text naming the login is
    // blocked, on the trigger and in the menu.
    expect(trigger.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    const label = Array.from(trigger.querySelectorAll('span')).find(
      (span) => span.textContent === 'GitHub username (octo-ada)',
    );
    expect(outermostReplayBlock(label ?? null)).toBe(label);
    const list = menu(trigger);
    expect(list?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(list?.getAttribute('aria-label')).toBeNull();
    const option = list?.querySelector('[role="option"][data-value="github"]');
    expect(
      option?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)?.textContent,
    ).toBe('GitHub username (octo-ada)');
  });

  it('records the dropdown when no login is known', () => {
    const trigger = renderSelect(null);
    expect(trigger.textContent).toBe('GitHub username');
    expect(outermostReplayBlock(trigger)).toBeNull();
    expect(
      menu(trigger)?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });
});
