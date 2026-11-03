/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { CODEX_SPEED_CATALOG_TTL_MS } from '@canopy/desktop-shared/lib/codex-speed-availability';
import type {
  CodexSpeedApi,
  CodexSpeedCatalog,
  CodexSpeedReadCapabilitiesOptions,
  ReadCodexSpeedRouteRequest,
} from '@canopy/desktop-shared/types/codex-speed-capabilities';
import { CODEX_SPEED_HELP_URL } from '@canopy/ui-shared';
import { resetCodexSpeedStoreForTests } from '@/stores/codexSpeedStore';
import {
  CHAT_LABEL,
  CHAT_UNIT_LABEL_PLURAL,
  WORKTREE_LABEL,
} from '@canopy/protocol';
import { CodexMultiAgentSettings, CodexTab } from '../CodexTab';
import {
  MULTI_AGENT_ROW_DESCRIPTORS,
  type MultiAgentField,
  buildMultiAgentPatch,
  saveMultiAgentPreference,
} from '../codexTabHelpers';

function makePreferences(
  overrides: Partial<PreferencesData> = {},
): PreferencesData {
  const defaults: PreferencesData = Object.assign(makeTestPreferences(), {
    worktreePanelPercent: 32,
    activityPanelExpanded: false,
    activityPanelWidthPercent: 25,
    kanbanWorktreePanelPercent: 32,
    kanbanActivityPanelExpanded: false,
    kanbanActivityPanelWidthPercent: 25,
    kanbanChatPanelVisible: false,
    sidebarCollapsed: false,
    branchNamePrefixMode: 'none',
    branchNameCustomPrefix: '',
    deleteBranchOnArchive: true,
    archiveOnMerge: true,
    defaultChatProvider: 'claude',
    defaultChatModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
      codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
      ollama: null,
    },
    personalWorkspaceCatalogSync: 'off',
    personalCatalogOfferSeen: false,
    personalCatalogNotice: null,
    defaultWorktreeProvider: 'claude',
    defaultWorktreeModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
      codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
      ollama: null,
    },
    summaryModel: 'claude-sonnet-4-6',
    summaryThinkingLevel: 'high',
    worktreeSummaryEnabled: true,
    worktreeSummaryModel: 'claude-haiku-4-5-20251001',
    worktreeSummaryThinkingLevel: 'off',
    prGenerationModel: 'claude-sonnet-4-6',
    prGenerationThinkingLevel: 'high',
    prInstructions: '',
    prInstructionMode: 'append',
    commitGenerationModel: 'claude-sonnet-4-6',
    commitGenerationThinkingLevel: 'high',
    commitInstructions: '',
    commitInstructionMode: 'append',
    branchNamingModel: 'claude-haiku-4-5-20251001',
    branchNamingThinkingLevel: 'off',
    branchNamingInstructions: '',
    providerModelConfigDefaults: { codex: { fastMode: false } },
    codexFastModeDefaultEnabled: false,
    branchDisplayMappings: [],
    reviewCommitMessage: false,
    agentRebaseResolutionEnabled: false,
    agentRebaseResolutionModel: null,
    agentRebaseResolutionThinkingLevel: null,
    mergeQueueAgentHandling: 'when_hook_absent',
    rtkEnabled: true,
    scriptTimeoutMinutes: 5,
    codexAppServerIdleTimeoutMinutes: 10,
    claudeSessionIdleTimeoutMinutes: 10,
    defaultChatInterfaceMode: 'canopy',
    maxActiveChatTurns: 10,
    maxActivePipelineExecutions: 5,
    memoryPressureGuardEnabled: false,
    bypassCodexAppServerIdleTimeoutUnderCriticalPressure: true,
    memoryPressureWarningThresholdBytes: 2 * 1024 * 1024 * 1024,
    memoryPressureCriticalThresholdBytes: 4 * 1024 * 1024 * 1024,
    keepSystemAwakeWhileAgentsActive: true,
    codexMultiAgentWorktreeChatsEnabled: false,
    codexMultiAgentStandaloneChatsEnabled: false,
    codexMultiAgentAppAdvisorEnabled: false,
    codexMultiAgentPipelinesEnabled: false,
    lastOpenApp: '',
    disabledOpenApps: [],
    lastSelectedWorktreeProjectId: '',
    lastSelectedWorktreeId: '',
    executionDetailViewMode: 'list',
    worktreeViewMode: 'list',
    worktreeFilterHiddenWorkspaceIds: [],
    auditRetentionDays: 7,
    theme: 'default',
    colorMode: 'dark',
    uiScale: 100,
    windowBounds: null,
    windowMaximized: false,
    windowFullScreen: false,
    ollamaServerPort: 11534,
    mcpProxyPort: 37645,
    hideAnthropicNav: false,
    lastActiveContext: null,
    fileAutoSave: false,
    inAppNotifications: {
      enabled: true,
      placement: 'bottom-right',
      categories: {
        chat: true,
        script: true,
        hook: true,
        gitCommit: true,
        gitPush: true,
        prCreate: true,
        pipeline: true,
        terminal: true,
        runComment: true,
        activation: true,
      },
    },
    terminalDrawerCollapsed: true,
    terminalDrawerHeight: 300,
    terminalDrawerActiveTabId: 'terminal',
    osNotifications: {
      enabled: false,
      skipWhenFocused: true,
      defaultSound: 'System',
      categories: {
        chat: true,
        script: true,
        hook: true,
        gitCommit: true,
        gitPush: true,
        prCreate: true,
        pipeline: true,
        terminal: true,
        runComment: true,
        activation: true,
      },
      categorySounds: {
        chat: 'Default',
        script: 'Default',
        hook: 'Default',
        gitCommit: 'Default',
        gitPush: 'Default',
        prCreate: 'Default',
        pipeline: 'Default',
        terminal: 'Default',
        runComment: 'Default',
        activation: 'Default',
      },
    },
    branchNamingPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    commitGenerationPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    prGenerationPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    worktreeSummaryPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    voiceDictationEnabled: true,
    mcpHttpAuthDefaultHandler: 'canopy',
    fileIndexing: {
      disabledBuiltinGlobIds: [],
      customGlobs: [],
    },
    autoDownloadUpdates: true,
    showDiagnosticsPill: true,
  });
  return Object.assign(defaults, overrides);
}

describe('CodexTab multi-agent settings', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const savePreferencesMock = jest.fn<
    Promise<PreferencesData>,
    [Partial<PreferencesData>]
  >();
  const loadPreferencesMock = jest.fn<Promise<PreferencesData>, []>();

  beforeEach(() => {
    savePreferencesMock.mockReset();
    savePreferencesMock.mockResolvedValue(makePreferences());
    loadPreferencesMock.mockReset();
    loadPreferencesMock.mockResolvedValue(makePreferences());
    installApi(loadPreferencesMock, savePreferencesMock);
  });

  afterEach(() => {
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
      return;
    }

    Reflect.deleteProperty(window, 'api');
  });

  it('exposes four independent rows in the documented order', () => {
    expect(MULTI_AGENT_ROW_DESCRIPTORS.map((r) => r.field)).toEqual([
      'codexMultiAgentWorktreeChatsEnabled',
      'codexMultiAgentStandaloneChatsEnabled',
      'codexMultiAgentAppAdvisorEnabled',
      'codexMultiAgentPipelinesEnabled',
    ]);
  });

  it('uses the documented copy for each row', () => {
    expect(MULTI_AGENT_ROW_DESCRIPTORS).toEqual([
      {
        field: 'codexMultiAgentWorktreeChatsEnabled',
        title: `${WORKTREE_LABEL} ${CHAT_UNIT_LABEL_PLURAL}`,
        helperText:
          'Applies to Codex chat sessions attached to a project worktree.',
        testId: 'settings-codex-multi-agent-worktree-chats',
      },
      {
        field: 'codexMultiAgentStandaloneChatsEnabled',
        title: `${CHAT_LABEL} ${CHAT_UNIT_LABEL_PLURAL}`,
        helperText: `Applies to Codex chat sessions in ${CHAT_LABEL.toLowerCase()} projects.`,
        testId: 'settings-codex-multi-agent-standalone-chats',
      },
      {
        field: 'codexMultiAgentAppAdvisorEnabled',
        title: 'Orchestrator',
        helperText: 'Applies to Codex-backed Orchestrator chats.',
        testId: 'settings-codex-multi-agent-app-advisor',
      },
      {
        field: 'codexMultiAgentPipelinesEnabled',
        title: 'Workflows',
        helperText:
          'Applies to Codex-backed workflow actions such as Agent Prompt and Agent Resume.',
        testId: 'settings-codex-multi-agent-pipelines',
      },
    ]);
  });

  it('builds a patch that sets only the toggled field', () => {
    expect(
      buildMultiAgentPatch('codexMultiAgentWorktreeChatsEnabled', true),
    ).toEqual({ codexMultiAgentWorktreeChatsEnabled: true });
    expect(
      buildMultiAgentPatch('codexMultiAgentStandaloneChatsEnabled', false),
    ).toEqual({ codexMultiAgentStandaloneChatsEnabled: false });
    expect(
      buildMultiAgentPatch('codexMultiAgentAppAdvisorEnabled', true),
    ).toEqual({ codexMultiAgentAppAdvisorEnabled: true });
    expect(
      buildMultiAgentPatch('codexMultiAgentPipelinesEnabled', true),
    ).toEqual({ codexMultiAgentPipelinesEnabled: true });
  });

  it('builds patches with exactly one key (no incidental state leak)', () => {
    for (const row of MULTI_AGENT_ROW_DESCRIPTORS) {
      const patch = buildMultiAgentPatch(row.field, true);
      expect(Object.keys(patch)).toEqual([row.field]);
    }
  });

  it('renders the documented section, labels, helper text, and switches', () => {
    const html = renderToStaticMarkup(
      <CodexMultiAgentSettings
        preferences={makePreferences()}
        onToggle={jest.fn<void, [MultiAgentField, boolean]>()}
      />,
    );

    expect(html).toContain('Multi-agent');
    expect(html).toContain(
      'Let Codex delegate work to subagents, which may use more tokens. Changes apply from the next turn.',
    );
    for (const row of MULTI_AGENT_ROW_DESCRIPTORS) {
      expect(html).toContain(row.title);
      expect(html).toContain(row.helperText);
      expect(html).toContain(`data-testid="${row.testId}"`);
    }
    expect(html.match(/role="switch"/g)).toHaveLength(
      MULTI_AGENT_ROW_DESCRIPTORS.length,
    );
  });

  it('uses the shared neutral field edge for the concurrency limit input', () => {
    const html = renderToStaticMarkup(
      <CodexMultiAgentSettings
        preferences={makePreferences()}
        onToggle={jest.fn<void, [MultiAgentField, boolean]>()}
        onLimitChange={jest.fn<void, [number | null]>()}
      />,
    );

    expect(html).toContain('shadow-field');
    expect(html).toContain('focus-visible:shadow-field-focus');
    expect(html).toContain('rounded-full');
    expect(html).not.toContain('border-border');
  });

  it('restores the persisted concurrency limit when saving fails', async () => {
    const initial = makePreferences({ codexMaxConcurrentSubagents: 3 });
    loadPreferencesMock.mockResolvedValue(initial);
    savePreferencesMock.mockRejectedValue(new Error('disk full'));
    const rendered = await renderCodexTab();

    try {
      const input = rendered.container.querySelector<HTMLInputElement>(
        '[data-testid="settings-codex-max-concurrent-subagents"]',
      );
      if (!input) throw new Error('Concurrency limit input not found');
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.bind(input);
      if (!setValue) throw new Error('Native input value setter not found');

      await act(async () => {
        input.focus();
        setValue('7');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.blur();
        await Promise.resolve();
      });

      expect(savePreferencesMock).toHaveBeenLastCalledWith({
        codexMaxConcurrentSubagents: 7,
      });
      expect(input.value).toBe('3');
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-codex-save-error"]',
        )?.textContent,
      ).toBe('Could not save Codex settings.');
    } finally {
      rendered.cleanup();
    }
  });

  it('calls the toggle handler with the correct preference field from each switch', async () => {
    const onToggle = jest.fn<void, [MultiAgentField, boolean]>();
    const rendered = await renderElement(
      <CodexMultiAgentSettings
        preferences={makePreferences()}
        onToggle={onToggle}
      />,
    );

    try {
      const switches =
        rendered.container.querySelectorAll<HTMLButtonElement>(
          '[role="switch"]',
        );
      expect(switches).toHaveLength(MULTI_AGENT_ROW_DESCRIPTORS.length);
      for (const row of MULTI_AGENT_ROW_DESCRIPTORS) {
        const toggle = rendered.container.querySelector<HTMLButtonElement>(
          `[data-testid="${row.testId}"]`,
        );
        if (!toggle) throw new Error(`Missing switch for ${row.field}`);
        expect(toggle.getAttribute('role')).toBe('switch');
        expect(toggle.getAttribute('aria-checked')).toBe('false');
        act(() => {
          toggle.click();
        });
        expect(onToggle).toHaveBeenLastCalledWith(row.field, true);
      }
    } finally {
      rendered.cleanup();
    }
  });

  it('persists each multi-agent toggle with only the changed preference field', async () => {
    for (const row of MULTI_AGENT_ROW_DESCRIPTORS) {
      await saveMultiAgentPreference(row.field, false);
      expect(savePreferencesMock).toHaveBeenLastCalledWith(
        buildMultiAgentPatch(row.field, false),
      );
    }
  });
});

const NOW = Date.parse('2026-09-30T12:00:00.000Z');

function speedCatalog(
  overrides: Partial<CodexSpeedCatalog> = {},
): CodexSpeedCatalog {
  return {
    generation: 1,
    status: 'ready',
    fetchedAt: NOW,
    expiresAt: NOW + CODEX_SPEED_CATALOG_TTL_MS,
    truncated: false,
    models: [
      {
        id: 'gpt-9-future',
        model: 'gpt-9-future',
        tiers: ['priority'],
        source: 'serviceTiers',
      },
    ],
    denials: [],
    ...overrides,
  };
}

const readCapabilitiesMock = jest.fn<
  Promise<CodexSpeedCatalog>,
  [CodexSpeedReadCapabilitiesOptions?]
>();
const openExternalMock = jest.fn<Promise<void>, [{ url: string }]>();

function installApi(
  loadPreferences: jest.Mock<Promise<PreferencesData>, []>,
  savePreferences: jest.Mock<
    Promise<PreferencesData>,
    [Partial<PreferencesData>]
  >,
): void {
  resetCodexSpeedStoreForTests();
  readCapabilitiesMock.mockReset();
  readCapabilitiesMock.mockResolvedValue(speedCatalog());
  openExternalMock.mockReset();
  openExternalMock.mockResolvedValue(undefined);
  const codexSpeed: CodexSpeedApi = {
    // Unresolved by default; a test replaces it to project a native route.
    readRoute: jest.fn(() =>
      Promise.resolve({
        modelSelection: 'explicit' as const,
        runtimeModel: null,
        modelSource: null,
        harness: null,
        routeProfile: 'unknown' as const,
      }),
    ),
    readCapabilities: readCapabilitiesMock,
    setActive: jest.fn(() => Promise.resolve()),
    onChanged: jest.fn(() => (): void => undefined),
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences,
      savePreferences,
      codexSpeed,
      browser: { openExternal: openExternalMock },
    },
  });
}

describe('CodexTab default speed', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const savePreferencesMock = jest.fn<
    Promise<PreferencesData>,
    [Partial<PreferencesData>]
  >();
  const loadPreferencesMock = jest.fn<Promise<PreferencesData>, []>();

  beforeEach(() => {
    loadPreferencesMock.mockReset();
    loadPreferencesMock.mockResolvedValue(makePreferences());
    savePreferencesMock.mockReset();
    savePreferencesMock.mockImplementation((patch) =>
      Promise.resolve(makePreferences(patch)),
    );
    installApi(loadPreferencesMock, savePreferencesMock);
  });

  afterEach(() => {
    resetCodexSpeedStoreForTests();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
      return;
    }
    Reflect.deleteProperty(window, 'api');
  });

  function radio(container: HTMLElement, speed: string): HTMLButtonElement {
    const input = container.querySelector<HTMLButtonElement>(
      `[data-testid="settings-codex-speed-default-${speed}"]`,
    );
    if (!input) throw new Error(`Missing ${speed} radio`);
    return input;
  }

  it('offers Regular, Fast, and Ultra fast as one choice list', async () => {
    const rendered = await renderCodexTab();
    try {
      const group = rendered.container.querySelector(
        '[data-testid="settings-codex-fast-mode-default"]',
      );
      expect(group?.getAttribute('role')).toBe('radiogroup');
      const labels = Array.from(
        group?.querySelectorAll('[role="radio"]') ?? [],
      ).map((row) => row.textContent);
      expect(labels[0]).toBe('Regular');
      expect(labels[1]).toBe('Fast');
      expect(labels[2]).toContain('Ultra fast');
      expect(
        radio(rendered.container, 'standard').getAttribute('aria-checked'),
      ).toBe('true');
      expect(rendered.container.textContent).toContain(
        'Higher speeds may use more of your subscription allowance.',
      );
      expect(rendered.container.textContent).not.toContain('2x');
    } finally {
      rendered.cleanup();
    }
  });

  it('reads a legacy Fast default and saves an exact speed with its derived boolean', async () => {
    loadPreferencesMock.mockResolvedValue(
      makePreferences({
        providerModelConfigDefaults: {},
        codexFastModeDefaultEnabled: true,
      }),
    );
    const rendered = await renderCodexTab();
    try {
      expect(
        radio(rendered.container, 'fast').getAttribute('aria-checked'),
      ).toBe('true');
      await act(async () => {
        radio(rendered.container, 'standard').click();
        await Promise.resolve();
      });
      expect(savePreferencesMock).toHaveBeenLastCalledWith({
        providerModelConfigDefaults: {
          codex: { speed: 'standard', fastMode: false },
        },
      });
    } finally {
      rendered.cleanup();
    }
  });

  it('keeps Ultra fast visible but unconfirmed until the defaults route is projected', async () => {
    const rendered = await renderCodexTab();
    try {
      const ultra = radio(rendered.container, 'ultrafast');
      expect(ultra.disabled).toBe(true);
      expect(ultra.textContent).toContain("Couldn't confirm availability");
    } finally {
      rendered.cleanup();
    }
  });

  it('does not qualify an Ultra fast default from the global catalog even when it advertises the tier', async () => {
    readCapabilitiesMock.mockResolvedValue(
      speedCatalog({
        models: [
          {
            id: 'gpt-9-future',
            model: 'gpt-9-future',
            tiers: ['priority', 'ultrafast'],
            source: 'serviceTiers',
          },
        ],
      }),
    );
    const rendered = await renderCodexTab();
    try {
      const ultra = radio(rendered.container, 'ultrafast');
      expect(ultra.disabled).toBe(true);
      expect(ultra.textContent).toContain("Couldn't confirm availability");
      await act(async () => {
        ultra.click();
        await Promise.resolve();
      });
      expect(savePreferencesMock).not.toHaveBeenCalled();
    } finally {
      rendered.cleanup();
    }
  });

  it('saves an Ultra fast default once the host projects a native defaults route', async () => {
    readCapabilitiesMock.mockResolvedValue(
      speedCatalog({
        models: [
          {
            id: 'gpt-first',
            model: 'gpt-first',
            tiers: ['priority'],
            source: 'serviceTiers',
          },
          {
            id: 'gpt-9-future',
            model: 'gpt-9-future',
            tiers: ['priority', 'ultrafast'],
            source: 'serviceTiers',
          },
        ],
      }),
    );
    const readRoute = jest.fn((request: ReadCodexSpeedRouteRequest) =>
      Promise.resolve({
        modelSelection: 'explicit' as const,
        runtimeModel: request.model ?? null,
        modelSource: 'codex-managed',
        harness: 'codex',
        routeProfile:
          request.model === 'gpt-9-future'
            ? ('codex-native' as const)
            : ('unknown' as const),
      }),
    );
    Object.assign(window.api.codexSpeed, { readRoute });
    const rendered = await renderCodexTab();
    try {
      expect(readRoute).toHaveBeenLastCalledWith({
        context: { kind: 'defaults' },
        model: 'gpt-9-future',
        modelSelection: 'explicit',
      });
      const ultra = radio(rendered.container, 'ultrafast');
      expect(ultra.disabled).toBe(false);
      await act(async () => {
        ultra.click();
        await Promise.resolve();
      });
      expect(savePreferencesMock).toHaveBeenLastCalledWith({
        providerModelConfigDefaults: {
          codex: { speed: 'ultrafast', fastMode: false },
        },
      });
    } finally {
      rendered.cleanup();
    }
  });

  it('keeps a saved Ultra fast default selected with its reason when it cannot run', async () => {
    loadPreferencesMock.mockResolvedValue(
      makePreferences({
        providerModelConfigDefaults: {
          codex: { speed: 'ultrafast', fastMode: false },
        },
      }),
    );
    const rendered = await renderCodexTab();
    try {
      expect(
        radio(rendered.container, 'ultrafast').getAttribute('aria-checked'),
      ).toBe('true');
      expect(
        radio(rendered.container, 'fast').getAttribute('aria-checked'),
      ).toBe('false');
      expect(savePreferencesMock).not.toHaveBeenCalled();
    } finally {
      rendered.cleanup();
    }
  });

  it('keeps missing tier metadata unconfirmed without crashing the defaults picker', async () => {
    readCapabilitiesMock.mockResolvedValue(
      speedCatalog({
        models: [
          {
            id: 'gpt-9-future',
            model: 'gpt-9-future',
            tiers: null,
            source: 'unknown',
          },
        ],
      }),
    );
    const rendered = await renderCodexTab();
    try {
      expect(radio(rendered.container, 'ultrafast').disabled).toBe(true);
      expect(radio(rendered.container, 'ultrafast').textContent).toContain(
        "Couldn't confirm availability",
      );
      expect(savePreferencesMock).not.toHaveBeenCalled();
    } finally {
      rendered.cleanup();
    }
  });

  it('offers a forced check when availability is unconfirmed', async () => {
    readCapabilitiesMock.mockResolvedValue(
      speedCatalog({ status: 'unknown', fetchedAt: null, models: [] }),
    );
    const rendered = await renderCodexTab();
    try {
      const refresh = rendered.container.querySelector<HTMLButtonElement>(
        '[data-testid="settings-codex-speed-refresh"]',
      );
      expect(refresh?.textContent).toBe('Check again');
      await act(async () => {
        refresh?.click();
        await Promise.resolve();
      });
      expect(readCapabilitiesMock).toHaveBeenLastCalledWith({ force: true });
    } finally {
      rendered.cleanup();
    }
  });

  it.each([false, true])(
    'keeps a manual check on a confirmed catalog (Ultra fast offered: %s)',
    async (offered) => {
      readCapabilitiesMock.mockResolvedValue(
        speedCatalog({
          models: [
            {
              id: 'gpt-9-future',
              model: 'gpt-9-future',
              tiers: offered ? ['priority', 'ultrafast'] : ['priority'],
              source: 'serviceTiers',
            },
          ],
        }),
      );
      const readRoute = jest.fn((request: ReadCodexSpeedRouteRequest) =>
        Promise.resolve({
          modelSelection: 'explicit' as const,
          runtimeModel: request.model ?? null,
          modelSource: 'codex-managed',
          harness: 'codex',
          routeProfile: 'codex-native' as const,
        }),
      );
      Object.assign(window.api.codexSpeed, { readRoute });
      const rendered = await renderCodexTab();
      try {
        const refresh = rendered.container.querySelector<HTMLButtonElement>(
          '[data-testid="settings-codex-speed-refresh"]',
        );
        expect(refresh?.textContent).toBe('Check again');
        expect(readRoute).toHaveBeenLastCalledWith({
          context: { kind: 'defaults' },
          model: 'gpt-9-future',
          modelSelection: 'explicit',
        });
        await act(async () => {
          refresh?.click();
          for (let index = 0; index < 10; index += 1) await Promise.resolve();
        });
        expect(readCapabilitiesMock).toHaveBeenLastCalledWith({ force: true });
        expect(readRoute.mock.calls.length).toBeGreaterThan(1);
      } finally {
        rendered.cleanup();
      }
    },
  );

  it('opens the provider speed guidance outside the app', async () => {
    const rendered = await renderCodexTab();
    try {
      await act(async () => {
        rendered.container
          .querySelector<HTMLButtonElement>(
            '[data-testid="settings-codex-speed-help"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(openExternalMock).toHaveBeenCalledWith({
        url: CODEX_SPEED_HELP_URL,
      });
    } finally {
      rendered.cleanup();
    }
  });
});

describe('CodexTab idle timeout', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const savePreferencesMock = jest.fn<
    Promise<PreferencesData>,
    [Partial<PreferencesData>]
  >();
  const loadPreferencesMock = jest.fn<Promise<PreferencesData>, []>();

  beforeEach(() => {
    loadPreferencesMock.mockReset();
    loadPreferencesMock.mockResolvedValue(makePreferences());
    savePreferencesMock.mockReset();
    installApi(loadPreferencesMock, savePreferencesMock);
  });

  afterEach(() => {
    resetCodexSpeedStoreForTests();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
      return;
    }
    Reflect.deleteProperty(window, 'api');
  });

  function idleInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-codex-idle-timeout-minutes"]',
    );
    if (!input) throw new Error('Missing Codex idle timeout input');
    return input;
  }

  async function enter(input: HTMLInputElement, value: string): Promise<void> {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.bind(input);
    if (!setValue) throw new Error('Missing value setter');
    act(() => {
      setValue(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
  }

  it('saves a clamped Codex timeout only', async () => {
    savePreferencesMock.mockImplementation((patch) =>
      Promise.resolve(makePreferences(patch)),
    );
    const rendered = await renderCodexTab();
    try {
      const input = idleInput(rendered.container);
      expect(input.value).toBe('10');
      expect(rendered.container.textContent).toContain(
        'Suspend idle Codex app-server processes after this long. Chat sessions are kept.',
      );

      await enter(input, '500');

      expect(savePreferencesMock).toHaveBeenCalledWith({
        codexAppServerIdleTimeoutMinutes: 120,
      });
      expect(input.value).toBe('120');
    } finally {
      rendered.cleanup();
    }
  });

  it('restores the saved timeout when saving fails or the entry is not a number', async () => {
    savePreferencesMock.mockRejectedValue(new Error('disk'));
    const rendered = await renderCodexTab();
    try {
      const input = idleInput(rendered.container);
      await enter(input, '30');
      expect(input.value).toBe('10');
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-codex-save-error"]',
        ),
      ).not.toBeNull();

      savePreferencesMock.mockClear();
      await enter(input, 'abc');
      expect(input.value).toBe('10');
      expect(savePreferencesMock).not.toHaveBeenCalled();
    } finally {
      rendered.cleanup();
    }
  });
});

async function renderCodexTab(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  return renderElement(<CodexTab />);
}

async function renderElement(element: JSX.Element): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(element);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
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
