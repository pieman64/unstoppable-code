/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OnboardingSuggestionSidebar } from '../OnboardingSuggestionSidebar';
import type {
  OnboardingChecklistView,
  OnboardingSuggestionStep,
} from '../queue';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
});

async function render(
  view: OnboardingChecklistView,
  busy: {
    focusShortcutBusy: boolean;
    launchAtLoginBusy?: boolean;
  },
  nontechnical = false,
): Promise<void> {
  await act(async () => {
    root.render(
      createElement(OnboardingSuggestionSidebar, {
        view,
        nontechnical,
        onActivate: (): void => undefined,
        launchAtLoginBusy: false,
        ...busy,
      }),
    );
    await Promise.resolve();
  });
}

function cta(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="sidebar-onboarding-suggestion-cta"]',
  );
}

function title(): string | null | undefined {
  return container.querySelector(
    '[data-testid="sidebar-onboarding-suggestion-title"]',
  )?.textContent;
}

function description(): string | null | undefined {
  return container.querySelector(
    '[data-testid="sidebar-onboarding-suggestion-description"]',
  )?.textContent;
}

const focusShortcutStep: OnboardingChecklistView = {
  entryId: 'focus-shortcut',
  step: { kind: 'enable-focus-shortcut', shortcut: '⌘⇧O' },
  status: 'pending',
};
const launchStep: OnboardingChecklistView = {
  entryId: 'launch-at-login',
  step: { kind: 'enable-launch-at-login' },
  status: 'pending',
};

describe('OnboardingSuggestionSidebar busy state', () => {
  it('only shows the busy label that belongs to the visible step', async () => {
    // A focus-shortcut round trip must not disable or relabel the launch at
    // sign-in row, and vice versa.
    await render(launchStep, {
      focusShortcutBusy: true,
      launchAtLoginBusy: false,
    });
    expect(title()).toBe('Open when you sign in');
    expect(cta()?.disabled).toBe(false);

    await render(focusShortcutStep, {
      focusShortcutBusy: false,
      launchAtLoginBusy: true,
    });
    expect(title()).toBe('Set up quick access');
    expect(cta()?.disabled).toBe(false);
  });

  it('shows the matching busy label and disables the action while its own round trip runs', async () => {
    await render(focusShortcutStep, {
      focusShortcutBusy: true,
    });
    expect(cta()?.textContent).toBe('Enabling shortcut');
    expect(cta()?.disabled).toBe(true);
  });
});

describe('OnboardingSuggestionSidebar launch at sign-in (CAN-3449)', () => {
  const launchAtLoginStep: OnboardingChecklistView = {
    entryId: 'launch-at-login',
    step: { kind: 'enable-launch-at-login' },
    status: 'pending',
  };

  it('asks to open the app at sign-in', async () => {
    await render(launchAtLoginStep, {
      focusShortcutBusy: true,
    });
    expect(title()).toBe('Open when you sign in');
    expect(cta()?.disabled).toBe(false);
  });

  it('shows its own busy label while its round trip runs', async () => {
    await render(launchAtLoginStep, {
      focusShortcutBusy: false,
      launchAtLoginBusy: true,
    });
    expect(cta()?.textContent).toBe('Turning on');
    expect(cta()?.disabled).toBe(true);
  });

  it('points a registration waiting for approval at System Settings', async () => {
    await render(
      {
        entryId: 'launch-at-login',
        step: { kind: 'launch-at-login-needs-approval' },
        status: 'pending',
      },
      { focusShortcutBusy: false },
    );
    expect(title()).toBe('Allow in System Settings');
  });
});

describe('OnboardingSuggestionSidebar card', () => {
  it('lays the step out like a toast: title, sentence, then the action and Skip', async () => {
    await render(focusShortcutStep, {
      focusShortcutBusy: false,
    });
    const card = container.querySelector(
      '[data-testid="sidebar-onboarding-suggestion-row"]',
    );
    expect(card?.classList).toContain('rounded-2xl');
    expect(card?.querySelector('[data-notice-shape="toast"]')).not.toBeNull();
    expect(title()).toBe('Set up quick access');
    expect(description()).toBe(
      'Open the app from anywhere with a keyboard shortcut.',
    );
    expect(cta()?.textContent).toBe('Turn on');
    // No separate heading, count, dots or arrows.
    expect(container.textContent).not.toContain('Getting started');
    expect(
      container.querySelector('[data-testid="sidebar-onboarding-progress"]'),
    ).toBeNull();
  });

  it('runs the action from the card and skips through Home', async () => {
    const onActivate = jest.fn();
    const onSkip = jest.fn();
    await act(async () => {
      root.render(
        createElement(OnboardingSuggestionSidebar, {
          view: focusShortcutStep,
          nontechnical: false,
          onActivate,
          onSkip,
          upcoming: 3,
          focusShortcutBusy: false,
          launchAtLoginBusy: false,
        }),
      );
      await Promise.resolve();
    });

    const card = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-onboarding-suggestion-row"]',
    );
    const action = cta();
    for (const testId of [
      'sidebar-onboarding-progress',
      'sidebar-onboarding-suggestion-dismiss',
      'sidebar-onboarding-suggestion-dismiss-previous',
    ]) {
      expect(container.querySelector(`[data-testid="${testId}"]`)).toBeNull();
    }
    // Two of the three steps still to come peek out behind the card.
    expect(
      container.querySelectorAll(
        '[data-testid="sidebar-onboarding-stack-card"]',
      ),
    ).toHaveLength(2);

    act(() => card?.click());
    expect(onActivate).toHaveBeenCalledTimes(1);
    act(() => action?.click());
    expect(onActivate).toHaveBeenCalledTimes(2);
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-onboarding-skip"]',
        )
        ?.click(),
    );
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it('ignores clicks on the card while the action is busy', async () => {
    const onActivate = jest.fn();
    await act(async () => {
      root.render(
        createElement(OnboardingSuggestionSidebar, {
          view: focusShortcutStep,
          nontechnical: false,
          onActivate,
          focusShortcutBusy: true,
          launchAtLoginBusy: false,
        }),
      );
      await Promise.resolve();
    });
    act(() => {
      // The card itself, where a pointer click runs the action when idle.
      container
        .querySelector<HTMLElement>(
          '[data-testid="sidebar-onboarding-suggestion-title"]',
        )
        ?.click();
      cta()?.click();
    });
    expect(onActivate).not.toHaveBeenCalled();
  });
});

const steps: OnboardingSuggestionStep[] = [
  { kind: 'import-projects-cta' },
  { kind: 'import-editor-setup-cta' },
  { kind: 'get-mobile-app' },
  { kind: 'add-repo-cta' },
  { kind: 'prompt', promptText: 'A task to plan' },
  { kind: 'connect-github' },
  { kind: 'github-try', promptText: 'Find and implement a TODO' },
  { kind: 'connect-tools', tools: [] },
  { kind: 'connect-agents' },
  { kind: 'create-plan' },
  { kind: 'connect-linear' },
  { kind: 'linear-try-prompt', promptText: 'Plan an assigned issue' },
  {
    kind: 'plugin-add',
    pluginKey: 'calendar',
    pluginName: 'calendar',
    displayName: 'Microsoft Outlook Calendar',
    description: 'Calendar tools',
    enableKeys: [],
    searchQuery: 'Calendar',
  },
  {
    kind: 'plugin-try',
    pluginKey: 'calendar',
    pluginName: 'calendar',
    displayName: 'Microsoft Outlook Calendar',
    promptText: 'Prepare for my next meeting',
  },
  {
    kind: 'advanced-readiness',
    label: 'Configure the repository setup scripts',
    workspaceId: 'repo',
    issue: {
      code: 'configure-scripts',
      title: 'Configure scripts',
      message: 'Add scripts',
      repoName: 'repo',
      fixPrompt: 'Configure scripts',
    },
  },
  {
    kind: 'advanced-prompt',
    label: 'Investigate the project and implement a small task',
    promptText: 'Find a TODO',
    requiresCodeWorkspace: true,
    tool: {
      key: 'github',
      kind: 'github',
      pluginName: 'github',
      displayName: 'GitHub',
      connected: true,
      promptTexts: [],
    },
  },
  { kind: 'enable-focus-shortcut', shortcut: 'Control+Command+Shift+Space' },
  { kind: 'focus-shortcut-blocked', shortcut: 'Control+Command+Shift+Space' },
  { kind: 'enable-launch-at-login' },
  { kind: 'launch-at-login-needs-approval' },
];

describe('sidebar copy fits without truncation', () => {
  it('uses one concise import action beneath the shared heading', async () => {
    await render(
      {
        entryId: 'import-projects',
        step: { kind: 'import-projects-cta' },
        status: 'pending',
      },
      {
        focusShortcutBusy: false,
      },
    );

    expect(title()).toBe('Import projects');
    expect(description()).toBe(
      'Bring your chats and projects from Claude and Codex.',
    );
    expect(cta()?.textContent).toBe('Import');
  });

  it('names the Cursor rules review', async () => {
    await render(
      {
        entryId: 'import-editor-setup',
        step: { kind: 'import-editor-setup-cta' },
        status: 'pending',
      },
      {
        focusShortcutBusy: false,
      },
    );

    expect(
      container.querySelector(
        '[data-testid="sidebar-onboarding-suggestion-title"]',
      )?.textContent,
    ).toBe('Use your Cursor rules');
  });

  it('names the agent connection step after AI providers', async () => {
    await render(
      {
        entryId: 'agent-connections',
        step: { kind: 'connect-agents' },
        status: 'pending',
      },
      {
        focusShortcutBusy: false,
      },
    );

    expect(
      container.querySelector(
        '[data-testid="sidebar-onboarding-suggestion-title"]',
      )?.textContent,
    ).toBe('Connect AI providers');
    expect(title()).toBe('Connect AI providers');
  });

  it.each(steps.map((step) => [step.kind, step] as const))(
    '%s uses a complete title of at most 30 characters, a sentence and a short action',
    async (_kind, step) => {
      for (const nontechnical of [false, true]) {
        await render(
          { entryId: 'agent-connections', step, status: 'pending' },
          {
            focusShortcutBusy: false,
          },
          nontechnical,
        );
        expect(
          container.querySelector(
            '[data-testid="sidebar-onboarding-suggestion-heading"]',
          ),
        ).toBeNull();
        const text =
          container.querySelector(
            '[data-testid="sidebar-onboarding-suggestion-title"]',
          )?.textContent ?? '';
        expect(text.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThanOrEqual(30);
        expect(text).not.toMatch(/…|\.\.\./);
        expect(description()).toMatch(/^[A-Z].*\.$/);
        // The action hugs a short label, and no tooltip repeats it (DESIGN.md).
        expect((cta()?.textContent ?? '').length).toBeLessThanOrEqual(14);
        expect(cta()?.hasAttribute('title')).toBe(false);
      }
    },
  );
  it('keeps prerequisite copy concise', async () => {
    await render(
      {
        entryId: 'linear',
        step: { kind: 'connect-linear' },
        status: 'deferred',
      },
      {
        focusShortcutBusy: false,
      },
    );
    const text =
      container.querySelector(
        '[data-testid="sidebar-onboarding-suggestion-title"]',
      )?.textContent ?? '';
    expect(text.length).toBeLessThanOrEqual(25);
  });
});

describe('OnboardingSuggestionSidebar project template rows (CAN-3032)', () => {
  const blueprint = { projectId: 'marketing-1', name: 'Marketing' };
  const pluginStep: OnboardingSuggestionStep = {
    kind: 'plugin-add',
    pluginKey: 'builtin/builtin-git',
    pluginName: 'builtin-git',
    displayName: 'Git',
    description: 'Git tools',
    enableKeys: ['builtin/builtin-git'],
    searchQuery: 'builtin-git',
  };
  const busy = { focusShortcutBusy: false };

  it('names the template plugin to add', async () => {
    await render(
      {
        entryId: 'blueprint:marketing-1:plugin:builtin-git',
        blueprint,
        step: pluginStep,
        status: 'pending',
      },
      busy,
    );
    expect(title()).toBe('Add Git');
  });

  it('names the template a starter prompt comes from', async () => {
    await render(
      {
        entryId: 'blueprint:marketing-1:prompt:ws-1',
        blueprint,
        step: {
          kind: 'prompt',
          label: 'Draft a launch announcement',
          promptText: 'Draft a launch announcement',
        },
        status: 'pending',
      },
      busy,
    );
    expect(title()).toBe('Try a Marketing prompt');
  });
});
