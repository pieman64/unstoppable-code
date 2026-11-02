/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  GitExecutableInstallProgress,
  GitExecutableStatus,
} from '@canopy/desktop-shared/types';
import { WindowsGitRequiredScreen } from '../WindowsGitRequiredScreen';
import type { WindowsGitGateState } from '@/hooks/useWindowsGitRequirement';

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

describe('WindowsGitRequiredScreen', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const openExternal = jest.fn<Promise<void>, [{ url: string }]>();

  beforeEach(() => {
    openExternal.mockReset();
    openExternal.mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { browser: { openExternal } },
    });
  });

  afterEach(() => {
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  function render(state: WindowsGitGateState): {
    container: HTMLElement;
    onRecheck: jest.Mock;
    onBrowse: jest.Mock;
    onAutoInstall: jest.Mock;
    onContinue: jest.Mock;
    cleanup: () => void;
  } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onRecheck = jest.fn();
    const onBrowse = jest.fn();
    const onAutoInstall = jest.fn();
    const onContinue = jest.fn();
    let root: Root | null = null;
    act(() => {
      root = createRoot(container);
      root.render(
        <WindowsGitRequiredScreen
          state={state}
          onRecheck={onRecheck}
          onBrowse={onBrowse}
          onAutoInstall={onAutoInstall}
          onContinue={onContinue}
          brandName="Canopy"
        />,
      );
    });
    return {
      container,
      onRecheck,
      onBrowse,
      onAutoInstall,
      onContinue,
      cleanup: (): void => {
        act(() => {
          root?.unmount();
        });
        container.remove();
      },
    };
  }

  it('offers branded Ubuntu apt instructions and documentation, never an app-run installer on Linux', () => {
    const prior = Object.getOwnPropertyDescriptor(window, 'platform');
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'linux',
    });
    const rendered = render({
      kind: 'required',
      status: makeStatus({
        platform: 'linux',
        error: 'Selected Git executable cannot be used.',
      }),
    });
    try {
      expect(
        rendered.container.querySelector(
          '[data-testid="linux-git-required-screen"]',
        ),
      ).not.toBeNull();
      expect(rendered.container.textContent).toContain('Canopy');
      expect(rendered.container.textContent).toContain('Ubuntu');
      expect(rendered.container.textContent).toContain('sudo apt install git');
      expect(rendered.container.textContent).toContain(
        'Selected Git executable cannot be used.',
      );
      expect(
        rendered.container.querySelector('[data-testid="git-gate-auto"]'),
      ).toBeNull();
      expect(
        rendered.container.querySelector(
          '[data-testid="git-gate-winget-hint"]',
        ),
      ).toBeNull();
      const manual = rendered.container.querySelector(
        '[data-testid="git-gate-manual"]',
      );
      if (!(manual instanceof HTMLButtonElement))
        throw new Error('Missing install instructions');
      act(() => {
        manual.click();
      });
      expect(openExternal).toHaveBeenCalledWith({
        url: 'https://git-scm.com/install/linux',
      });
      expect(rendered.onAutoInstall).not.toHaveBeenCalled();
    } finally {
      rendered.cleanup();
      if (prior) Object.defineProperty(window, 'platform', prior);
      else Reflect.deleteProperty(window, 'platform');
    }
  });

  it('shows the required title and the exact description copy with the Git link', () => {
    const rendered = render({ kind: 'required', status: makeStatus() });
    try {
      expect(
        rendered.container.querySelector('[data-testid="git-gate-title"]')
          ?.textContent,
      ).toBe('Git installation is required');
      expect(rendered.container.textContent).toContain(
        'No Git installation was detected and it must be installed in order to use Canopy.',
      );
      const link = rendered.container.querySelector(
        '[data-testid="git-gate-git-link"]',
      );
      expect(link?.getAttribute('href')).toBe('https://git-scm.com/');
    } finally {
      rendered.cleanup();
    }
  });

  it('opens the Git homepage externally when the Git link is clicked', () => {
    const rendered = render({ kind: 'required', status: makeStatus() });
    try {
      const link = rendered.container.querySelector(
        '[data-testid="git-gate-git-link"]',
      );
      if (!(link instanceof HTMLAnchorElement)) {
        throw new Error('Git link not found');
      }
      act(() => {
        link.click();
      });
      expect(openExternal).toHaveBeenCalledWith({
        url: 'https://git-scm.com/',
      });
    } finally {
      rendered.cleanup();
    }
  });

  it('shows Auto, Manual, Browse, and Recheck when winget is available', () => {
    const rendered = render({
      kind: 'required',
      status: makeStatus({ wingetAvailable: true }),
    });
    try {
      const auto = rendered.container.querySelector(
        '[data-testid="git-gate-auto"]',
      );
      expect(auto).not.toBeNull();
      expect((auto as HTMLButtonElement).disabled).toBe(false);
      expect(
        rendered.container.querySelector('[data-testid="git-gate-manual"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="git-gate-browse"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="git-gate-recheck"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector(
          '[data-testid="git-gate-winget-hint"]',
        ),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('disables Auto with helper text when winget is unavailable, keeping Manual, Browse, and Recheck', () => {
    const rendered = render({
      kind: 'required',
      status: makeStatus({ wingetAvailable: false }),
    });
    try {
      const auto = rendered.container.querySelector(
        '[data-testid="git-gate-auto"]',
      );
      expect((auto as HTMLButtonElement).disabled).toBe(true);
      expect(
        rendered.container.querySelector('[data-testid="git-gate-winget-hint"]')
          ?.textContent,
      ).toBe('Automatic installation requires winget.');
      expect(
        rendered.container.querySelector('[data-testid="git-gate-manual"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="git-gate-browse"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="git-gate-recheck"]'),
      ).not.toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('opens the Windows install page from Manual and leaves Auto/Manual/Browse/Recheck visible', () => {
    const rendered = render({ kind: 'required', status: makeStatus() });
    try {
      const manual = rendered.container.querySelector(
        '[data-testid="git-gate-manual"]',
      );
      if (!(manual instanceof HTMLButtonElement)) {
        throw new Error('Manual button not found');
      }
      act(() => {
        manual.click();
      });
      expect(openExternal).toHaveBeenCalledWith({
        url: 'https://git-scm.com/install/windows',
      });
      // The screen is unchanged: the three actions remain visible.
      expect(
        rendered.container.querySelector('[data-testid="git-gate-auto"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="git-gate-manual"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="git-gate-browse"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="git-gate-recheck"]'),
      ).not.toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('invokes the recheck callback from the Recheck action', () => {
    const rendered = render({ kind: 'required', status: makeStatus() });
    try {
      const recheck = rendered.container.querySelector(
        '[data-testid="git-gate-recheck"]',
      );
      act(() => {
        (recheck as HTMLButtonElement).click();
      });
      expect(rendered.onRecheck).toHaveBeenCalledTimes(1);
    } finally {
      rendered.cleanup();
    }
  });

  it('invokes the browse callback from the Browse action', () => {
    const rendered = render({ kind: 'required', status: makeStatus() });
    try {
      const browse = rendered.container.querySelector(
        '[data-testid="git-gate-browse"]',
      );
      act(() => {
        (browse as HTMLButtonElement).click();
      });
      expect(rendered.onBrowse).toHaveBeenCalledTimes(1);
    } finally {
      rendered.cleanup();
    }
  });

  it('shows an indeterminate progress bar and the phase message while installing', () => {
    const progress: GitExecutableInstallProgress = {
      phase: 'running',
      message: 'Installing Git via winget…',
    };
    const rendered = render({ kind: 'installing', status: null, progress });
    try {
      expect(
        rendered.container.querySelector('[data-testid="git-gate-title"]')
          ?.textContent,
      ).toBe('Installing Git');
      const bar = rendered.container.querySelector(
        '[data-testid="git-gate-progress"]',
      );
      expect(bar).not.toBeNull();
      expect(bar?.getAttribute('role')).toBe('progressbar');
      // Indeterminate: no concrete value reported.
      expect(bar?.getAttribute('aria-valuenow')).toBeNull();
      expect(
        rendered.container.querySelector(
          '[data-testid="git-gate-progress-message"]',
        )?.textContent,
      ).toBe('Installing Git via winget…');
      // All actions are disabled while the install runs.
      for (const testid of [
        'git-gate-auto',
        'git-gate-manual',
        'git-gate-browse',
        'git-gate-recheck',
      ]) {
        const button = rendered.container.querySelector(
          `[data-testid="${testid}"]`,
        );
        expect((button as HTMLButtonElement).disabled).toBe(true);
      }
    } finally {
      rendered.cleanup();
    }
  });

  it('allows Linux to recheck a selected executable before continuing', () => {
    const prior = Object.getOwnPropertyDescriptor(window, 'platform');
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'linux',
    });
    const rendered = render({
      kind: 'detected',
      status: makeStatus({
        platform: 'linux',
        ready: true,
        path: '/test/selected-git',
        source: 'user-selected',
      }),
    });
    try {
      const recheck = rendered.container.querySelector<HTMLButtonElement>(
        '[data-testid="git-gate-recheck"]',
      );
      expect(recheck).not.toBeNull();
      act(() => recheck?.click());
      expect(rendered.onRecheck).toHaveBeenCalledTimes(1);
      expect(rendered.onContinue).not.toHaveBeenCalled();
    } finally {
      rendered.cleanup();
      if (prior) Object.defineProperty(window, 'platform', prior);
      else Reflect.deleteProperty(window, 'platform');
    }
  });

  it('shows the detected path and only Continue after a successful Windows recheck', () => {
    const rendered = render({
      kind: 'detected',
      status: makeStatus({
        ready: true,
        path: 'C:\\Program Files\\Git\\cmd\\git.exe',
        version: '2.45.0',
        source: 'auto-detected',
      }),
    });
    try {
      expect(
        rendered.container.querySelector(
          '[data-testid="git-gate-detected-message"]',
        )?.textContent,
      ).toBe('Git was detected at C:\\Program Files\\Git\\cmd\\git.exe.');
      const continueButton = rendered.container.querySelector(
        '[data-testid="git-gate-continue"]',
      );
      expect(continueButton).not.toBeNull();
      act(() => {
        (continueButton as HTMLButtonElement).click();
      });
      expect(rendered.onContinue).toHaveBeenCalledTimes(1);
      // The missing-Git actions are gone in the success state.
      expect(
        rendered.container.querySelector('[data-testid="git-gate-auto"]'),
      ).toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="git-gate-manual"]'),
      ).toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="git-gate-browse"]'),
      ).toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="git-gate-recheck"]'),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('surfaces the failure message and restores the actions on error', () => {
    const rendered = render({
      kind: 'error',
      status: makeStatus({ wingetAvailable: true }),
      message: 'Git installation failed.',
    });
    try {
      expect(
        rendered.container.querySelector('[data-testid="git-gate-error"]')
          ?.textContent,
      ).toBe('Git installation failed.');
      expect(
        rendered.container.querySelector('[data-testid="git-gate-auto"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="git-gate-browse"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="git-gate-recheck"]'),
      ).not.toBeNull();
    } finally {
      rendered.cleanup();
    }
  });
});
