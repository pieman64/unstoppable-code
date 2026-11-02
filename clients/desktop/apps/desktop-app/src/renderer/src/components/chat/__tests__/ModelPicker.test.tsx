/**
 * @jest-environment jsdom
 *
 * Uses the repo's createRoot + act jsdom convention (see
 * VariableInsertDropdown.test.tsx); @testing-library/react is not installed.
 * The root mounts on document.body so the picker's portal (also rendered into
 * document.body via createPortal) is covered by React event delegation.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import type * as SettingsDestinationsModule from '@/lib/navigation/settings-destinations';
import type * as HostedSettingsAvailabilityModule from '@/components/settings/hosted/hosted-settings-availability';
import type { SettingsRoute } from '@canopy/protocol/settings';
import { BILLING_TOP_UP_MIN_USD } from '@canopy/protocol/billing';
import { useNavigationStore } from '@/stores/navigationStore';
import { act, createElement, type ReactNode } from 'react';
// Type-only: erased at runtime, so it is safe above the hoisted `jest.mock`
// factory that uses it to keep `requireActual`'s spread typed.
import type * as GuestCredentialModule from '@/hooks/useIsGuestCredential';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { resolveChatBillingFramework } from '@/lib/chatBillingFramework';
import { dispatchChatHarnessAction } from '@/lib/chat-harness-actions';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import {
  invalidateSharedAiCreditsRead,
  resetSettingsCloseRereadForTests,
} from '@/lib/openBillingPage';
import { resetModelLibraryAccessForTests } from '@/lib/modelLibraryAccess';
import {
  clearModelUnlockIntent,
  resetModelUnlockIntentForTests,
  useModelUnlockIntentStore,
} from '@/lib/modelUnlockIntent';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import { createRoot, type Root } from 'react-dom/client';
import { setRendererCodexAccountModels } from '@/stores/billingLaneRuntime';
import {
  AGENT_MODELS,
  DEFAULT_OLLAMA_HARNESS,
  clearCodexAccountModels,
  setCodexAccountModels,
  getProviderForModel,
  initAgentModels,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initCursorModels,
  getCursorModelEntries,
  initCopilotModels,
  initOpenCodeModels,
  getCopilotModelEntries,
  getModelDisplayName,
  getModelPickerMappings,
  getOpenCodeModelEntries,
  initModelHarnessAssignments,
  initOllamaModels,
  resetGatewayCatalogHydrationForTests,
} from '@canopy/desktop-shared/types';
import type {
  AiGatewayModelEntry,
  ChatModel,
  GatewayRouteEntry,
  ModelHarness,
  ModelHarnessAssignment,
  ModelRegistrySnapshot,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import type { AgentModelRegistryEntry } from '@canopy/desktop-shared/types/agent-models';
import { replaceModelFamilyMetadata } from '@canopy/desktop-shared/model-config';
const mockOpenAccountOrganizationPage = jest.fn<'settings', [unknown]>();
jest.mock('@/lib/navigation/settings-destinations', () => ({
  ...jest.requireActual<typeof SettingsDestinationsModule>(
    '@/lib/navigation/settings-destinations',
  ),
  openAccountOrganizationPage: (route: unknown): 'settings' =>
    mockOpenAccountOrganizationPage(route),
}));
const mockHostedSettingsOpenable = jest.fn<boolean, []>(() => false);
jest.mock('@/components/settings/hosted/hosted-settings-availability', () => ({
  ...jest.requireActual<typeof HostedSettingsAvailabilityModule>(
    '@/components/settings/hosted/hosted-settings-availability',
  ),
  hostedSettingsOpenable: (): boolean => mockHostedSettingsOpenable(),
  useHostedSettingsAvailable: (): boolean => mockHostedSettingsOpenable(),
}));

// Stub AuthLoginModal so the no-native-login Sign-in CTA test can assert the
// modal opens without pulling the real settings-auth dependency graph into the
// picker unit test. The stub renders a recognizable testid (with the provider)
// only while mounted, which mirrors the real modal's mount-on-open contract.
jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: ({ provider }: { provider: string }): ReactNode =>
    createElement(
      'div',
      { 'data-testid': 'auth-login-modal', 'data-provider': provider },
      'auth-login-modal',
    ),
}));

let mockOpenCodeAvailable = false;
jest.mock('@/hooks/useOpenCodeChatAvailable', () => ({
  useOpenCodeChatAvailable: (enabled: boolean): boolean =>
    enabled && mockOpenCodeAvailable,
}));

jest.mock('@/hooks/useOpenCodeModels', () => ({
  useOpenCodeModels: (): { models: never[] } => ({ models: [] }),
}));

jest.mock('@/hooks/useCursorChatAvailable', () => ({
  useCursorChatAvailable: jest.fn((enabled: boolean) => enabled),
}));

jest.mock('@/hooks/useCopilotChatAvailable', () => ({
  useCopilotChatAvailable: jest.fn((enabled: boolean): boolean => enabled),
}));
jest.mock('@/hooks/useOpenCodeChatAvailable', () => ({
  useOpenCodeChatAvailable: jest.fn((enabled: boolean): boolean => enabled),
}));
jest.mock('@/hooks/useCopilotModels', () => ({
  useCopilotModels: (): {
    models: ReturnType<typeof getCopilotModelEntries>;
  } => ({ models: getCopilotModelEntries() }),
}));
jest.mock('@/hooks/useOpenCodeModels', () => ({
  useOpenCodeModels: (): {
    models: ReturnType<typeof getOpenCodeModelEntries>;
  } => ({ models: getOpenCodeModelEntries() }),
}));

/**
 * CAN-3026 — guest-ness, controlled per test.
 *
 * Mocked rather than driven through `window.api.loadCanopyCloudAccount` so the
 * picker's guest reading stays independent of the RECOVERY MODAL's account
 * read, which every case below also stubs. The two answer different questions
 * and a shared stub would let one test's intent silently supply the other's.
 * `requireActual` preserves the module's `isGuestAccount` re-export.
 */
let mockIsGuest = false;
jest.mock('@/hooks/useIsGuestCredential', () => ({
  ...jest.requireActual<typeof GuestCredentialModule>(
    '@/hooks/useIsGuestCredential',
  ),
  useIsGuestCredential: (): boolean => mockIsGuest,
}));

/**
 * CAN-4028 — the owner's model-library access, driven the same way as
 * `mockIsGuest`. `undefined` is unknown, which is what every pre-existing case
 * in this file runs under: no purchase lock, and guests gated by guest-ness
 * alone. The second argument is the picker's "rows can be gated here" switch;
 * honoring it keeps the configuration surfaces lock-free exactly as in
 * production.
 */
let mockLibraryAccess: ModelLibraryAccess | undefined;
jest.mock('@/hooks/useModelLibraryAccess', () => ({
  useWorkModelLibraryAccess: (
    _scope: unknown,
    enabled = true,
  ): ModelLibraryAccess | undefined =>
    enabled ? mockLibraryAccess : undefined,
}));

let mockCursorMessage: string | undefined;
let mockUseRegisteredCursorModels = false;
jest.mock('@/hooks/useCursorModels', () => ({
  useCursorModels: (): {
    models: ReturnType<typeof getCursorModelEntries>;
    message: string | undefined;
  } => ({
    models: mockUseRegisteredCursorModels
      ? getCursorModelEntries()
      : [
          {
            id: 'cursor-default',
            rawModelId: 'default[]',
            label: 'Cursor default',
          },
        ],
    message: mockCursorMessage,
  }),
}));

import {
  MODEL_PICKER_AUTO_REASONS,
  pickerChromeMenuHeightPx,
} from '@canopy/ui-shared';
import { ModelPicker } from '../ModelPicker';
import {
  useCloudConnectGateStore,
  type CloudConnectGateContext,
} from '@/stores/cloudConnectGateStore';
import { brandText } from '@/lib/brand';
import type {
  ProviderAvailability,
  ProviderModelAvailability,
} from '@/hooks/useProviderAvailability';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import type { ChatBillingResolution } from '@/lib/chatBillingFramework';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

// Gateway-routable via the route table, plus a per-provider model with no
// gateway route so gateway-only gating can disable it.
const CLAUDE_GATEWAY = 'opus';
const CLAUDE_NON_GATEWAY = 'claude-legacy-test';
// Legacy-snapshot gateway-only ids still inlined into the managed registries.
// Their gateway-only status comes from the route table, not registry
// membership; the picker regroups them into the branded AI Credits section.
const CLAUDE_GATEWAY_ONLY = 'claude-gateway-only-test';
const FABLE_EXTRA_CHARGE = 'claude-fable-5-1';
const CODEX_GATEWAY = 'codex-native-gateway-test';
const CODEX_NON_GATEWAY = 'codex-legacy-test';
const CODEX_GATEWAY_ONLY = 'deepseek-v4-pro';
const DEEPSEEK_FLASH = 'deepseek-v4-flash';
const KIMI_K2 = 'kimi-k2-thinking';
const KIMI_K3 = 'kimi-k3';
const GLM = 'glm-5.2';
const MINIMAX = 'minimax-m3';
const OLLAMA_MODEL = 'llama-test';
// API-only rows that exist solely in the AI_GATEWAY_MODELS registry (hydrated
// via initAiGatewayModels), one per recommended harness.
const GATEWAY_API_CODEX = 'zephyr-9';
const GATEWAY_API_CLAUDE = 'aurora-lite';

function gatewayRoute(
  modelId: string,
  recommendedHarness: 'claude' | 'codex',
  gatewayOnly: boolean,
): GatewayRouteEntry {
  return {
    modelId,
    gatewayId: `vendor/${modelId}`,
    family: modelId,
    recommendedHarness,
    gatewayOnly,
    contextWindow: 100_000,
    supportsPromptCaching: false,
    supportedThinkingLevels: [],
    toolSchemaProfile: 'standard',
  };
}

function providerForModel(model: ChatModel): AgentProviderType {
  const provider = getProviderForModel(model);
  if (provider === undefined) {
    throw new Error(`Expected a provider for model ${model}`);
  }
  return provider;
}

function apiGatewayEntry(
  id: string,
  label: string,
  recommendedHarness: 'claude' | 'codex',
  familyMetadata?: {
    family: string;
    familyLabel: string;
    vendor: string;
    sortOrder: number;
  },
): AiGatewayModelEntry {
  return {
    id,
    label,
    ...familyMetadata,
    recommendedHarness,
    contextWindow: 100_000,
    supportsPromptCaching: false,
    supportedThinkingLevels: [],
    toolSchemaProfile: 'standard',
  };
}

const API_GATEWAY_ENTRIES: AiGatewayModelEntry[] = [
  apiGatewayEntry(GATEWAY_API_CODEX, 'Zephyr 9', 'codex'),
  apiGatewayEntry(GATEWAY_API_CLAUDE, 'Aurora Lite', 'claude'),
  apiGatewayEntry(CODEX_GATEWAY_ONLY, 'DeepSeek V4 Pro', 'codex', {
    family: 'deepseek',
    familyLabel: 'DeepSeek',
    vendor: 'deepseek',
    sortOrder: 80,
  }),
  apiGatewayEntry(DEEPSEEK_FLASH, 'DeepSeek V4 Flash', 'codex', {
    family: 'deepseek',
    familyLabel: 'DeepSeek',
    vendor: 'deepseek',
    sortOrder: 81,
  }),
  apiGatewayEntry(KIMI_K2, 'Kimi K2 Thinking', 'codex', {
    family: 'moonshot',
    familyLabel: 'Moonshot AI',
    vendor: 'moonshot',
    sortOrder: 90,
  }),
  apiGatewayEntry(KIMI_K3, 'Kimi K3', 'codex', {
    family: 'moonshot',
    familyLabel: 'Moonshot AI',
    vendor: 'moonshot',
    sortOrder: 91,
  }),
  apiGatewayEntry(GLM, 'GLM-5.2', 'codex', {
    family: 'zai',
    familyLabel: 'Z.ai',
    vendor: 'zai',
    sortOrder: 100,
  }),
  apiGatewayEntry(MINIMAX, 'MiniMax M3', 'codex', {
    family: 'minimax',
    familyLabel: 'MiniMax',
    vendor: 'minimax',
    sortOrder: 110,
  }),
];

// Native registry init no longer feeds the gateway route table —
// initAiGatewayModels is the only writer, and it atomically replaces both the
// API-only rows and ALL routes. Managed-model routes therefore live here.
const GATEWAY_ROUTES: GatewayRouteEntry[] = [
  gatewayRoute(CLAUDE_GATEWAY, 'claude', false),
  gatewayRoute(CLAUDE_GATEWAY_ONLY, 'claude', true),
  gatewayRoute(CODEX_GATEWAY, 'codex', false),
  gatewayRoute(CODEX_GATEWAY_ONLY, 'codex', true),
  gatewayRoute(GATEWAY_API_CODEX, 'codex', true),
  gatewayRoute(GATEWAY_API_CLAUDE, 'claude', true),
  gatewayRoute(DEEPSEEK_FLASH, 'codex', true),
  gatewayRoute(KIMI_K2, 'codex', true),
  gatewayRoute(KIMI_K3, 'codex', true),
  gatewayRoute(GLM, 'codex', true),
  gatewayRoute(MINIMAX, 'codex', true),
];

/**
 * (Re-)hydrate every model registry to the baseline fixture state. Called once
 * in beforeAll; tests that mutate the gateway registry re-run it to restore.
 */
function registerModelRegistries(
  apiEntries: AiGatewayModelEntry[] = API_GATEWAY_ENTRIES,
): void {
  replaceModelFamilyMetadata([
    {
      id: CLAUDE_GATEWAY,
      family: 'opus',
      familyLabel: 'Opus',
      vendor: 'anthropic',
      sortOrder: 20,
    },
    {
      id: FABLE_EXTRA_CHARGE,
      family: 'fable',
      familyLabel: 'Fable',
      vendor: 'anthropic',
      sortOrder: 10,
    },
    {
      id: CODEX_GATEWAY,
      family: 'codex',
      familyLabel: 'Codex',
      vendor: 'openai',
      sortOrder: 60,
    },
  ]);
  initClaudeModels([
    {
      id: CLAUDE_GATEWAY,
      label: 'Opus',
      description: 'Best for complex, long-running work.',
    },
    { id: CLAUDE_NON_GATEWAY, label: 'Claude Legacy' },
    { id: CLAUDE_GATEWAY_ONLY, label: 'Claude Gateway Only' },
    {
      id: FABLE_EXTRA_CHARGE,
      label: 'Fable 5.1',
      description: 'Fast, capable everyday model.',
      extraChargeOnly: true,
      extraChargeMessage: 'Requires extra usage credits',
    },
  ]);
  initCodexModels([
    { id: CODEX_GATEWAY, label: 'Codex Native Gateway' },
    { id: CODEX_NON_GATEWAY, label: 'Codex Legacy' },
  ]);
  initOllamaModels([
    {
      id: OLLAMA_MODEL,
      rawModelId: OLLAMA_MODEL,
      label: 'Llama Test',
      show: { capabilities: ['completion', 'tools'] },
    },
  ]);
  initAiGatewayModels(apiEntries, GATEWAY_ROUTES);
}

beforeAll(() => {
  registerModelRegistries();
});

beforeEach(() => {
  window.localStorage.clear();
  // Harness assignments are module-level hydrated state; start every test from
  // the empty snapshot so only tests that opt in observe assignments and the
  // provider-derived fallbacks stay covered.
  initModelHarnessAssignments({ revision: 0, assignments: [] });
});

if (typeof globalThis.requestAnimationFrame === 'undefined') {
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (cb: FrameRequestCallback): number => {
      cb(0);
      return 0;
    },
  });
}

let root: Root | null = null;

function render(node: ReactNode): void {
  root = createRoot(document.body);
  act(() => {
    root?.render(node);
  });
}

function openPicker(): void {
  const button = document.querySelector<HTMLButtonElement>(
    '[data-testid="chat-model-picker"]',
  );
  if (!button) throw new Error('picker button not found');
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function option(model: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    `[data-testid="chat-model-option-${model}"]`,
  );
  if (!el) throw new Error(`option ${model} not found`);
  return el;
}

function isDisabled(model: string): boolean {
  return option(model).getAttribute('aria-disabled') === 'true';
}

afterEach(() => {
  resetSettingsCloseRereadForTests();
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
  initAgentModels([]);
  useModelCatalogStore.setState({ policy: new Set<string>() });
  // The shared availability read retains its settled answer for the current
  // episode, and this file mounts `GetAiCreditsCta` (whose mount effect seeds
  // one) through the recovery modal. Reset it so a retained answer cannot
  // satisfy the next test's assertions for the wrong reason.
  invalidateSharedAiCreditsRead();
  mockIsGuest = false;
  mockLibraryAccess = undefined;
  resetModelLibraryAccessForTests();
  resetModelUnlockIntentForTests();
  mockCursorMessage = undefined;
  mockOpenCodeAvailable = false;
});

const unavailableProvider = (): ProviderModelAvailability => ({
  selectable: false,
  nativeAuth: false,
  creditsEligible: false,
  loading: false,
});

// Matches how `resolveModelRowGate` treats a provider with no availability
// entry (available, not loading), which is what these fixtures had before the
// harnesses became required keys.
const unspecifiedProvider = (): ProviderModelAvailability => ({
  selectable: true,
  nativeAuth: true,
  creditsEligible: false,
  loading: false,
});

const availability = (
  overrides: Partial<ProviderAvailability>,
): ProviderAvailability => ({
  claude: overrides.claude ?? unavailableProvider(),
  codex: overrides.codex ?? unavailableProvider(),
  ollama: overrides.ollama ?? {
    selectable: true,
    nativeAuth: true,
    creditsEligible: false,
    loading: false,
  },
  copilot: overrides.copilot ?? unspecifiedProvider(),
  cursor: overrides.cursor ?? unspecifiedProvider(),
  opencode: overrides.opencode ?? unspecifiedProvider(),
});

function renderPicker(
  providerAvailability?: ProviderAvailability,
  extra: {
    onModelChange?: (
      model: string,
      billingFramework?: 'subscription' | 'ai-credits',
      executionHarness?: string,
    ) => void;
    onStartNewChat?: (model: string) => void;
    currentModel?: string;
    browserLayout?: 'harnesses';
    lockedProvider?: 'claude' | 'codex';
    lockedHarness?: 'claude' | 'codex';
    lockedProviderBehavior?: 'disabled' | 'continue';
  } = {},
): void {
  render(
    createElement(ModelPicker, {
      currentModel: extra.currentModel ?? CLAUDE_GATEWAY,
      onModelChange: extra.onModelChange ?? ((): void => {}),
      providerAvailability,
      browserLayout: extra.browserLayout,
      lockedProvider: extra.lockedProvider,
      lockedHarness: extra.lockedHarness,
      lockedProviderBehavior: extra.lockedProviderBehavior,
      ...(extra.onStartNewChat ? { onStartNewChat: extra.onStartNewChat } : {}),
    }),
  );
  openPicker();
}

/** CAN-2349: a row that resolved to `hidden` is not in the DOM at all. */
function isAbsent(model: string): boolean {
  return (
    document.querySelector(`[data-testid="chat-model-option-${model}"]`) ===
    null
  );
}

function clickOption(model: string): void {
  act(() => {
    option(model).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Hovers the model trigger and waits out its long tooltip delay. */
function hoverTriggerPastTooltipDelay(trigger: HTMLElement): void {
  jest.useFakeTimers();
  try {
    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      jest.advanceTimersByTime(1000);
    });
  } finally {
    jest.useRealTimers();
  }
}

function hoverOption(model: string): void {
  act(() => {
    option(model).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

/**
 * CAN-2701: every row's summary, context window, extra-charge note, and
 * unavailable reason now live in one hover detail popover. Hover the row first,
 * then read it.
 */
function optionDetailText(model: string): string {
  hoverOption(model);
  return (
    document.querySelector('[data-testid="chat-model-option-detail"]')
      ?.textContent ?? ''
  );
}

function recoveryModal(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="model-recovery-modal"]',
  );
}

/**
 * CAN-2349's central assertion: a RECOVERABLE row must be byte-identical to an
 * available one. Anything a user could perceive as "this is gated" — before
 * they have clicked it — is a bug, not a hint.
 */
function expectIndistinguishable(model: string): void {
  const row = option(model);
  expect(row.getAttribute('aria-disabled')).toBeNull();
  // `aria-describedby` is deliberately NOT asserted: since CAN-2701 every row
  // — available or recoverable — points at its own detail popover, so its
  // presence no longer distinguishes anything. What must stay absent is the
  // gating language, which the tooltip check below covers.
  expect(row.disabled).toBe(false);
  expect(row.className).toContain('hover:bg-subtle');
  expect(row.querySelector('.sr-only')).toBeNull();
  // No pre-emptive recovery tooltip. A configured model description may now
  // appear here, but availability details remain in the recovery modal.
  hoverOption(model);
  expect(
    document.querySelector('[data-testid="chat-model-unavailable-tooltip"]'),
  ).toBeNull();
}

/**
 * CAN-4028 — a library-locked row. The deliberate exception to
 * {@link expectIndistinguishable}: it shows the lock and the shared hint, and
 * is still an enabled, activatable row rather than a disabled one.
 */
function expectLibraryLocked(
  model: string,
  hint: string,
  label?: string,
): void {
  const row = option(model);
  expect(row.getAttribute('data-locked')).toBe('true');
  expect(row.disabled).toBe(false);
  expect(row.getAttribute('aria-disabled')).not.toBe('true');
  expect(row.textContent).toContain(hint);
  // CAN-4705: sign-in locks name the remedy beside the lock; purchase-only
  // locks keep the row's usual tag.
  const lockLabel = row.querySelector('[data-testid*="-option-lock-label"]');
  expect(lockLabel?.textContent).toBe(label);
}

describe('Cursor picker surfaces', () => {
  it.each([true, false])(
    'gates custom Cursor Agents with the surface opt-in: %s',
    (allowCursor) => {
      initAgentModels([agentEntry({ baseModel: 'cursor-default' })]);
      render(
        createElement(ModelPicker, {
          currentModel: 'sonnet',
          onModelChange: jest.fn(),
          allowCursor,
        }),
      );
      openPicker();
      expect(isAbsent('agent_model_reviewer')).toBe(!allowCursor);
    },
  );

  it('uses the shared model default and offers a per-chat harness choice only before starting', () => {
    const rawModelId = `${CODEX_NON_GATEWAY}[reasoning=medium]`;
    const id = `cursor:${encodeURIComponent(rawModelId)}`;
    initCursorModels([{ id, rawModelId, label: 'Cursor variant' }]);
    initModelHarnessAssignments({
      revision: 1,
      assignments: [
        {
          modelId: CODEX_NON_GATEWAY,
          source: 'codex-managed',
          harness: 'cursor',
          defaultHarness: 'codex',
          configurable: true,
          overridden: true,
        },
      ],
    });
    const onModelChange = jest.fn();
    try {
      render(
        createElement(ModelPicker, {
          currentModel: CODEX_NON_GATEWAY,
          onModelChange,
          allowCursor: true,
        }),
      );
      expect(
        document.querySelector('[data-testid="chat-harness-picker"]'),
      ).not.toBeNull();
      const slices = useCurrentUiStateStore.getState().slices;
      const pickerId = Object.keys(slices)
        .find((key) => key.startsWith('chat.harnessPicker.'))
        ?.slice('chat.harnessPicker.'.length);
      if (!pickerId) throw new Error('Missing reported harness picker');
      const button = document.querySelector(
        '[data-testid="chat-harness-picker"]',
      );
      if (!button) throw new Error('Missing harness picker');
      Object.defineProperty(button, 'checkVisibility', { value: () => true });
      act(() => {
        expect(dispatchChatHarnessAction(pickerId, 'cursor')).toBe(true);
      });
      expect(onModelChange).toHaveBeenCalledWith(id);
      act(() => {
        expect(dispatchChatHarnessAction(pickerId, 'claude')).toBe(false);
      });
      openPicker();
      clickOption(CODEX_NON_GATEWAY);
      expect(onModelChange).toHaveBeenCalledWith(id);
      act(() => {
        root?.unmount();
      });
      render(
        createElement(ModelPicker, {
          currentModel: id,
          onModelChange,
          allowCursor: true,
          lockedHarness: 'cursor',
        }),
      );
      expect(
        document.querySelector('[data-testid="chat-harness-picker"]'),
      ).toBeNull();
      expect(dispatchChatHarnessAction(pickerId, 'cursor')).toBe(false);
    } finally {
      initCursorModels([]);
    }
  });
  it('keeps the context window of a model saved to run on Cursor', () => {
    // Cursor reports no context window, so the row must not trade the model's
    // own for Cursor's missing one.
    const rawModelId = `${CLAUDE_NON_GATEWAY}[thinking=true]`;
    const id = `cursor:${encodeURIComponent(rawModelId)}`;
    initClaudeModels([
      {
        id: CLAUDE_NON_GATEWAY,
        label: 'Claude Legacy',
        contextWindow: 1_000_000,
      },
    ]);
    initCursorModels([{ id, rawModelId, label: 'Cursor variant' }]);
    initModelHarnessAssignments({
      revision: 1,
      assignments: [
        {
          modelId: CLAUDE_NON_GATEWAY,
          source: 'claude-managed',
          harness: 'cursor',
          defaultHarness: 'claude',
          configurable: true,
          overridden: true,
        },
      ],
    });
    try {
      render(
        createElement(ModelPicker, {
          currentModel: CLAUDE_NON_GATEWAY,
          onModelChange: jest.fn(),
          allowCursor: true,
        }),
      );
      openPicker();
      expect(optionDetailText(CLAUDE_NON_GATEWAY)).toContain('1M context');
    } finally {
      initCursorModels([]);
      registerModelRegistries();
    }
  });
  it('offers Cursor on an eligible new-task surface without a chat identity', () => {
    const onModelChange = jest.fn();
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange,
        allowCursor: true,
      }),
    );
    openPicker();
    expect(isAbsent('cursor-default')).toBe(false);
    expect(
      document.querySelector(
        '[data-testid="chat-model-option-label-cursor-default"]',
      )?.textContent,
    ).toBe('Default');
    clickOption('cursor-default');
    expect(onModelChange).toHaveBeenCalledWith('cursor-default');
  });

  it.each([false, true])(
    'offers Cursor with AI Credits billing (locked toggle: %s)',
    (disabled) => {
      const onModelChange = jest.fn();
      render(
        createElement(ModelPicker, {
          currentModel: CLAUDE_GATEWAY,
          onModelChange,
          allowCursor: true,
          billing: {
            value: 'ai-credits',
            provider: 'claude',
            onChange: (): void => {},
            disabled,
          },
        }),
      );
      openPicker();
      expect(isAbsent('cursor-default')).toBe(false);
      expect(isDisabled('cursor-default')).toBe(false);
      clickOption('cursor-default');
      expect(onModelChange).toHaveBeenCalledWith('cursor-default');
    },
  );

  it('keeps Cursor out of configuration pickers by default', () => {
    renderPicker();
    expect(isAbsent('cursor-default')).toBe(true);
  });

  it('does not infer Cursor eligibility from a recovery chat identity', () => {
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: jest.fn(),
        recoveryChatKey: 'existing-chat',
      }),
    );
    openPicker();
    expect(isAbsent('cursor-default')).toBe(true);
  });
});

describe('ModelPicker availability gating', () => {
  it('shows the configured model description on hover, never truncated inline', () => {
    renderPicker();

    // Inline, the summary was cut off mid-sentence on every row.
    expect(
      document.querySelector('[data-testid^="chat-model-option-description"]'),
    ).toBeNull();
    expect(optionDetailText(CLAUDE_GATEWAY)).toContain(
      'Best for complex, long-running work.',
    );
  });

  it('puts extra-charge content before the description in one tooltip', () => {
    renderPicker();

    const text = optionDetailText(FABLE_EXTRA_CHARGE);
    expect(text).toContain('Extra charge only');
    expect(text).toContain('Requires extra usage credits');
    expect(text).toContain('Fast, capable everyday model.');
    expect(text.indexOf('Requires extra usage credits')).toBeLessThan(
      text.indexOf('Fast, capable everyday model.'),
    );
  });

  it('preserves the provider mark and uses a compact app chevron in the capsule trigger', () => {
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: (): void => {},
        capsule: true,
      }),
    );

    const trigger = document.querySelector('[data-testid="chat-model-picker"]');
    expect(trigger?.className).toContain('text-xs');
    expect(trigger?.className).toContain('fg-primary');
    expect(trigger?.className).not.toContain('text-2xs');
    const icons = trigger?.querySelectorAll<SVGElement>(
      '[data-app-icon="true"]',
    );
    expect(icons).toHaveLength(2);
    expect(icons?.[0]?.getAttribute('style')).toContain('width: 16px');
    expect(icons?.[0]?.getAttribute('style')).toContain('height: 16px');
    expect(icons?.[1]?.getAttribute('style')).toContain('width: 14px');
    expect(icons?.[1]?.getAttribute('style')).toContain('height: 14px');
    expect(icons?.[1]?.classList.contains('ml-0.5')).toBe(false);
    expect(icons?.[1]?.classList.contains('fg-quaternary')).toBe(true);
    expect(icons?.[0]?.classList.contains('fg-secondary')).toBe(true);
  });

  it('native auth enables the whole group with no credit badge', () => {
    renderPicker(
      availability({
        claude: {
          selectable: true,
          nativeAuth: true,
          creditsEligible: false,
          loading: false,
        },
      }),
    );

    expect(isDisabled(CLAUDE_GATEWAY)).toBe(false);
    expect(isDisabled(CLAUDE_NON_GATEWAY)).toBe(false);
    expect(
      document.querySelector('[data-testid="chat-model-option-credit-routed"]'),
    ).toBeNull();
  });

  it('uses one fixed leading rail and text column for provider and model rows', () => {
    renderPicker(
      availability({
        claude: {
          selectable: true,
          nativeAuth: true,
          creditsEligible: false,
          loading: false,
        },
        codex: {
          selectable: true,
          nativeAuth: true,
          creditsEligible: false,
          loading: false,
        },
      }),
    );

    for (const model of [CLAUDE_GATEWAY, CODEX_GATEWAY]) {
      const group = option(model).closest('[role="group"]');
      const groupLabel = group?.querySelector<HTMLElement>(
        '[data-testid^="chat-model-group-label-"]',
      );
      const header = groupLabel?.parentElement;
      const iconRail = header?.firstElementChild;
      expect(header?.className).toContain('gap-2');
      expect(header?.className).toContain('px-2');
      expect(iconRail?.className).toContain('h-4');
      expect(iconRail?.className).toContain('w-4');
      expect(iconRail?.className).toContain('shrink-0');
      expect(groupLabel?.className).toContain('min-w-0');
      expect(groupLabel?.className).toContain('truncate');
    }

    for (const model of [CLAUDE_GATEWAY, CLAUDE_NON_GATEWAY, CODEX_GATEWAY]) {
      const row = option(model);
      const leadingRail = row.firstElementChild;
      const label = document.querySelector<HTMLElement>(
        `[data-testid="chat-model-option-label-${model}"]`,
      );
      expect(row.className).toContain('h-8');
      expect(row.className).toContain('gap-2');
      expect(row.className).toContain('px-2');
      expect(leadingRail?.className).toContain('w-4');
      expect(leadingRail?.className).toContain('shrink-0');
      expect(label?.parentElement?.className).toContain('min-w-0');
      expect(label?.className).toContain('truncate');
    }
  });

  it('gateway-only leaves a non-routable row recoverable, not disabled, with no per-row badge', () => {
    renderPicker(
      availability({
        codex: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: true,
          loading: false,
        },
      }),
    );

    expect(isDisabled(CODEX_GATEWAY)).toBe(false);
    // CAN-2349 case A: credits exist but cannot route this model and there is
    // no native login, so it is RECOVERABLE — and a recoverable row is
    // indistinguishable from an available one until it is clicked.
    expect(isDisabled(CODEX_NON_GATEWAY)).toBe(false);
    expectIndistinguishable(CODEX_NON_GATEWAY);
    // Credit-routed models are enabled silently — no per-row "AI Credits" badge
    // (account-level routing status lives in the shared chat banner instead).
    expect(
      document.querySelectorAll(
        '[data-testid="chat-model-option-credit-routed"]',
      ),
    ).toHaveLength(0);
  });

  it('no auth and no credits keeps rows selectable and opens the recovery modal on click', () => {
    renderPicker(availability({}));

    // Case A. The whole point of the ticket: no dim, no lock node, no tooltip.
    expect(isDisabled(CLAUDE_GATEWAY)).toBe(false);
    expect(isDisabled(CLAUDE_NON_GATEWAY)).toBe(false);
    expect(
      document.querySelector('[data-testid="chat-model-option-locked-claude"]'),
    ).toBeNull();
    expectIndistinguishable(CLAUDE_GATEWAY);

    // Clicking is no longer a dead end.
    expect(recoveryModal()).toBeNull();
    clickOption(CLAUDE_GATEWAY);
    expect(recoveryModal()).not.toBeNull();
  });

  it('does not commit the model when the recovery modal is cancelled', () => {
    // The highest-value guard in the ticket. `AuthLoginModal` invalidates the
    // provider cache on unmount, which makes availability report `loading` —
    // and the row gate is OPTIMISTIC while loading. A modal that re-derived its
    // branch from live props would read that transient as "gate cleared" and
    // silently commit a model the user explicitly cancelled.
    const onModelChange = jest.fn();
    renderPicker(availability({}), { onModelChange });

    clickOption(CLAUDE_NON_GATEWAY);
    expect(recoveryModal()).not.toBeNull();

    act(() => {
      document
        .querySelector(
          '[data-testid="model-recovery-modal"] button[aria-label="Close"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(recoveryModal()).toBeNull();
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('keeps a recoverable row looking identical across loading and resolved', () => {
    // A row must not change appearance as probes settle — a flicker from
    // normal to gated is exactly the leak of account state this ticket removes.
    renderPicker(
      availability({
        claude: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: false,
          loading: true,
        },
      }),
    );
    const whileLoading = option(CLAUDE_GATEWAY).className;

    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';

    renderPicker(availability({}));
    expect(option(CLAUDE_GATEWAY).className).toBe(whileLoading);
  });

  it('optimistically enables while loading (no flash-disable)', () => {
    renderPicker(
      availability({
        claude: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: false,
          loading: true,
        },
      }),
    );

    expect(isDisabled(CLAUDE_GATEWAY)).toBe(false);
    expect(isDisabled(CLAUDE_NON_GATEWAY)).toBe(false);
    expect(
      document.querySelector('[data-testid="chat-model-option-credit-routed"]'),
    ).toBeNull();
  });

  it('keeps Ollama selectable regardless of auth or credits', () => {
    renderPicker(availability({}));
    expect(isDisabled(OLLAMA_MODEL)).toBe(false);
  });

  it('treats an omitted availability prop as fully available (back-compat)', () => {
    renderPicker(undefined);
    expect(isDisabled(CLAUDE_GATEWAY)).toBe(false);
    expect(isDisabled(CODEX_GATEWAY)).toBe(false);
    expect(isDisabled(OLLAMA_MODEL)).toBe(false);
  });
});

describe('ModelPicker compact tooltip', () => {
  it('surfaces the selected model in a rich tooltip when the label is hidden', () => {
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: (): void => {},
        hideLabel: true,
      }),
    );

    // No tooltip is mounted until the trigger is hovered.
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-picker"]',
    );
    if (!trigger) throw new Error('trigger not found');
    expect(trigger.className).toContain('whitespace-nowrap');
    hoverTriggerPastTooltipDelay(trigger);

    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Opus',
    );
  });

  it('says what the control governs when the label is already visible', () => {
    // CAN-2701: the trigger used to carry `title="Model"`, which restated the
    // control's own name. With the label visible the tooltip must add the one
    // thing the chip cannot say — what this choice applies to — and must not
    // repeat the model name the user can already read.
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: (): void => {},
      }),
    );

    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-picker"]',
    );
    if (!trigger) throw new Error('trigger not found');
    expect(trigger.getAttribute('title')).toBeNull();
    hoverTriggerPastTooltipDelay(trigger);

    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('Model for this chat');
  });

  it('lets a config surface name what it configures instead', () => {
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: (): void => {},
        triggerTooltip: 'Model this automation runs on',
      }),
    );

    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-picker"]',
    );
    if (!trigger) throw new Error('trigger not found');
    hoverTriggerPastTooltipDelay(trigger);

    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Model this automation runs on',
    );
  });
});

describe('ModelPicker gateway-only gating', () => {
  it('uses each gateway-only model’s recommended harness for availability', () => {
    const onModelChange = jest.fn();
    renderPicker(
      availability({
        claude: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: true,
          loading: false,
        },
        codex: {
          selectable: false,
          nativeAuth: false,
          creditsEligible: false,
          loading: false,
        },
      }),
      { onModelChange },
    );

    // Neither row is dimmed now, so the harness routing is asserted through
    // BEHAVIOR instead: the covered one commits, the uncovered one recovers.
    expect(isDisabled(CLAUDE_GATEWAY_ONLY)).toBe(false);
    expect(isDisabled(CODEX_GATEWAY_ONLY)).toBe(false);

    clickOption(CODEX_GATEWAY_ONLY);
    expect(recoveryModal()).not.toBeNull();
    expect(onModelChange).not.toHaveBeenCalled();

    act(() => {
      document
        .querySelector(
          '[data-testid="model-recovery-modal"] button[aria-label="Close"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    openPicker();
    clickOption(CLAUDE_GATEWAY_ONLY);
    expect(onModelChange).toHaveBeenCalledWith(CLAUDE_GATEWAY_ONLY);
  });

  it('makes a gateway-only row recoverable (case B) when credits are missing', () => {
    // Native Codex auth, but no AI Credits. A gateway-only model can never bill
    // to a subscription, so native auth does not help — but it is still
    // recoverable (buy credits), not a dead end.
    renderPicker(
      availability({
        codex: {
          selectable: true,
          nativeAuth: true,
          creditsEligible: false,
          loading: false,
        },
      }),
    );

    expect(isDisabled(CODEX_GATEWAY)).toBe(false);
    expect(isDisabled(CODEX_GATEWAY_ONLY)).toBe(false);
    expectIndistinguishable(CODEX_GATEWAY_ONLY);

    clickOption(CODEX_GATEWAY_ONLY);
    expect(recoveryModal()).not.toBeNull();
    // Case B never offers provider sign-in: no subscription can pay for a
    // gateway-only model, so "Sign in to Codex" would unblock nothing.
    expect(
      document.querySelector('[data-testid="model-recovery-sign-in"]'),
    ).toBeNull();
  });

  it('enables a gateway-only row when the user has AI Credits', () => {
    renderPicker(
      availability({
        codex: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: true,
          loading: false,
        },
      }),
    );

    expect(isDisabled(CODEX_GATEWAY_ONLY)).toBe(false);
  });

  it('stays optimistically enabled while availability is loading', () => {
    renderPicker(
      availability({
        codex: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: false,
          loading: true,
        },
      }),
    );

    expect(isDisabled(CODEX_GATEWAY_ONLY)).toBe(false);
  });

  it('keeps a settled gateway-only row recoverable when only native auth is inconclusive', () => {
    const onModelChange = jest.fn();
    renderPicker(
      availability({
        codex: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: false,
          loading: true,
          creditsLoading: false,
        },
      }),
      { onModelChange },
    );

    // Native-auth loading must not make the row immediately selectable once
    // the credits probe has settled. The recovery design keeps the row
    // clickable, but routes the click to credits recovery instead of committing
    // the model.
    expect(isDisabled(CODEX_GATEWAY_ONLY)).toBe(false);
    clickOption(CODEX_GATEWAY_ONLY);
    expect(recoveryModal()).not.toBeNull();
    expect(onModelChange).not.toHaveBeenCalled();
  });
});

describe('ModelPicker vendor sections and AI Credits badges', () => {
  it('keeps the AI Credits label for an unset Home billing preference', () => {
    const onChange = jest.fn();
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: jest.fn(),
        browserLayout: 'harnesses',
        providerAvailability: availability({
          claude: {
            selectable: true,
            nativeAuth: false,
            creditsEligible: true,
            loading: false,
          },
        }),
        billing: { value: undefined, provider: 'claude', onChange },
      }),
    );
    openPicker();
    expect(option(CLAUDE_GATEWAY).textContent).toContain('AI Credits');
  });

  it('keeps unrelated signed-out Codex rows labelled AI Credits during Claude subscription billing', () => {
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: jest.fn(),
        browserLayout: 'harnesses',
        providerAvailability: availability({
          codex: {
            selectable: true,
            nativeAuth: false,
            creditsEligible: true,
            loading: false,
          },
        }),
        billing: {
          value: 'subscription',
          provider: 'claude',
          allowUnverifiedSubscription: true,
          onChange: jest.fn(),
        },
      }),
    );
    openPicker();
    expect(
      document.querySelector(
        `[data-testid="chat-model-row-credits-${CODEX_GATEWAY}"]:not([hidden] *)`,
      )?.textContent,
    ).toBe('AI Credits');
  });

  it('labels Claude rows AI Credits when credits pay for a signed-out Claude', () => {
    renderPicker(
      availability({
        claude: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: true,
          loading: false,
        },
      }),
      { browserLayout: 'harnesses' },
    );
    expect(
      document.querySelector(
        `[data-testid="chat-model-row-credits-${CLAUDE_GATEWAY}"]:not([hidden] *)`,
      )?.textContent,
    ).toBe('AI Credits');
  });

  describe('CAN-5028 Free AI Credits tag', () => {
    const ACME = '11111111-1111-4111-8111-111111111111';

    function setContext(kind: 'personal' | 'organization'): void {
      act(() => {
        useWorkspaceContextStore.setState({
          state: {
            context:
              kind === 'personal'
                ? { kind: 'personal' }
                : { kind: 'organization', organizationId: ACME },
            revision: 1,
            organizations: [{ id: ACME, name: 'Acme', role: 'MEMBER' }],
          },
          hydrated: true,
        });
      });
    }

    afterEach(() => {
      act(() => {
        useWorkspaceContextStore.setState(
          useWorkspaceContextStore.getInitialState(),
          true,
        );
      });
    });

    function creditsTag(): string | null | undefined {
      return document.querySelector(
        `[data-testid="chat-model-row-credits-${CLAUDE_GATEWAY}"]:not([hidden] *)`,
      )?.textContent;
    }

    const creditsPaid = (): ProviderAvailability =>
      availability({
        claude: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: true,
          loading: false,
        },
      });

    it.each([
      ['personal', 'needs_purchase', 'Free AI Credits'],
      ['personal', 'unlocked', 'AI Credits'],
      ['personal', undefined, 'AI Credits'],
      // Organization work never shows the viewer's own pre-purchase state.
      ['organization', 'needs_purchase', 'AI Credits'],
    ] as const)(
      'tags an available credit row in %s work with %s access as %s',
      (context, access, label) => {
        setContext(context);
        mockLibraryAccess = access;
        renderPicker(creditsPaid(), { browserLayout: 'harnesses' });
        expect(creditsTag()).toBe(label);
      },
    );
  });

  it('keeps Claude rows unlabelled while Claude is signed in', () => {
    renderPicker(
      availability({
        claude: {
          selectable: true,
          nativeAuth: true,
          creditsEligible: true,
          loading: false,
        },
      }),
      { browserLayout: 'harnesses' },
    );
    expect(
      document.querySelector(
        `[data-testid="chat-model-row-credits-${CLAUDE_GATEWAY}"]`,
      ),
    ).toBeNull();
  });

  it('shows a failed hosted-model download on All and retries it', () => {
    const retryAiGatewayCatalog = jest.fn(
      (): Promise<void> => Promise.resolve(),
    );
    const previous = useModelCatalogStore.getState();
    useModelCatalogStore.setState({
      aiGatewayCatalogStatus: 'failed',
      retryAiGatewayCatalog,
    });
    try {
      renderPicker(undefined, { browserLayout: 'harnesses' });
      const retry = document.querySelector<HTMLElement>(
        '[data-testid="chat-model-gateway-catalog-retry"]',
      );
      expect(
        document.querySelector(
          '[data-testid="chat-model-gateway-catalog-failed"]',
        ),
      ).not.toBeNull();
      act(() => retry?.click());
      expect(retryAiGatewayCatalog).toHaveBeenCalledTimes(1);
    } finally {
      useModelCatalogStore.setState({
        aiGatewayCatalogStatus: previous.aiGatewayCatalogStatus,
        retryAiGatewayCatalog: previous.retryAiGatewayCatalog,
      });
    }
  });

  describe('organization empty list', () => {
    const connected = (): ProviderAvailability =>
      availability({
        claude: {
          selectable: true,
          nativeAuth: true,
          creditsEligible: false,
          loading: false,
        },
      });

    function narrowRegistries(): void {
      initClaudeModels([{ id: CLAUDE_GATEWAY, label: 'Opus' }]);
      initCodexModels([]);
      initOllamaModels([]);
      initAiGatewayModels([], []);
    }

    function emptyTitle(): string | null | undefined {
      const empty = document.querySelector(
        '[data-testid="chat-model-catalog-empty"]',
      );
      return empty === null ? null : empty.textContent;
    }

    afterEach(() => {
      act(() => {
        useModelCatalogStore.setState({
          modelGatewayEnforced: false,
          activeOrganizationName: undefined,
          activeOwner: undefined,
        });
        useWorkspaceContextStore.setState(
          useWorkspaceContextStore.getInitialState(),
          true,
        );
      });
      mockOpenAccountOrganizationPage.mockReset();
      resetGatewayCatalogHydrationForTests();
      registerModelRegistries();
    });

    it('says the organization turned models off when policy blocks every row', () => {
      narrowRegistries();
      useModelCatalogStore.setState({
        policy: new Set<string>([CLAUDE_GATEWAY]),
      });
      renderPicker(connected(), { browserLayout: 'harnesses' });
      expect(emptyTitle()).toContain('Your organization turned off all models');
    });

    it('names the organization that owns the work when its policy blocks every row', () => {
      narrowRegistries();
      useModelCatalogStore.setState({
        policy: new Set<string>([CLAUDE_GATEWAY]),
        activeOrganizationName: 'Acme',
      });
      renderPicker(connected(), { browserLayout: 'harnesses' });
      expect(emptyTitle()).toContain('Acme turned off all models');
    });

    describe('Manage model policy', () => {
      const ACME = '11111111-1111-4111-8111-111111111111';

      function blockedForRole(
        role: 'OWNER' | 'ADMIN' | 'MEMBER',
        ownerOrganizationId: string = ACME,
        membershipId: string = ACME,
      ): void {
        narrowRegistries();
        useModelCatalogStore.setState({
          policy: new Set<string>([CLAUDE_GATEWAY]),
          activeOrganizationName: 'Acme',
          activeOwner: {
            kind: 'organization',
            organizationId: ownerOrganizationId,
          },
        });
        useWorkspaceContextStore.setState({
          state: {
            context: { kind: 'organization', organizationId: membershipId },
            revision: 1,
            organizations: [{ id: membershipId, name: 'Acme', role }],
          },
          hydrated: true,
        });
        renderPicker(connected(), { browserLayout: 'harnesses' });
      }

      function manageAction(): HTMLButtonElement | null {
        return document.querySelector<HTMLButtonElement>(
          '[data-testid="model-catalog-empty-manage-policy"]',
        );
      }

      it.each(['OWNER', 'ADMIN'] as const)(
        'lets an %s open the organization policies',
        (role) => {
          blockedForRole(role);
          expect(emptyTitle()).toContain('Acme turned off all models');
          act(() => manageAction()?.click());
          expect(mockOpenAccountOrganizationPage).toHaveBeenCalledWith({
            scope: 'organization',
            organizationId: ACME,
            page: 'settings',
            subtab: 'policies',
          });
        },
      );

      it("opens the membership's ID when the owner ID differs in case", () => {
        const id = 'abcdef01-abcd-4abc-8abc-abcdefabcdef';
        blockedForRole('OWNER', id.toUpperCase(), id);
        act(() => manageAction()?.click());
        expect(mockOpenAccountOrganizationPage).toHaveBeenCalledWith({
          scope: 'organization',
          organizationId: id,
          page: 'settings',
          subtab: 'policies',
        });
      });

      it('asks a member to ask their admin instead', () => {
        blockedForRole('MEMBER');
        expect(emptyTitle()).toContain('Ask your admin to turn one on');
        expect(manageAction()).toBeNull();
      });
    });

    it('keeps the list when policy leaves a model to pick', () => {
      useModelCatalogStore.setState({
        policy: new Set<string>([CLAUDE_NON_GATEWAY]),
      });
      renderPicker(connected(), { browserLayout: 'harnesses' });
      expect(emptyTitle()).toBeNull();
    });

    it('keeps the list while an enforced gateway list is still loading', () => {
      narrowRegistries();
      resetGatewayCatalogHydrationForTests();
      useModelCatalogStore.setState({ modelGatewayEnforced: true });
      renderPicker(connected(), { browserLayout: 'harnesses' });
      expect(emptyTitle()).toBeNull();
    });

    it('says the organization added no models once the gateway list arrived empty', () => {
      narrowRegistries();
      // Arrives with one route, then the organization's filter removes it.
      initAiGatewayModels(API_GATEWAY_ENTRIES, GATEWAY_ROUTES);
      initAiGatewayModels([], []);
      useModelCatalogStore.setState({ modelGatewayEnforced: true });
      renderPicker(connected(), { browserLayout: 'harnesses' });
      expect(emptyTitle()).toContain(
        "Your organization hasn't added any models yet",
      );
    });

    it('names the owning organization when its gateway list arrived empty', () => {
      narrowRegistries();
      initAiGatewayModels(API_GATEWAY_ENTRIES, GATEWAY_ROUTES);
      initAiGatewayModels([], []);
      useModelCatalogStore.setState({
        modelGatewayEnforced: true,
        activeOrganizationName: 'Acme',
      });
      renderPicker(connected(), { browserLayout: 'harnesses' });
      expect(emptyTitle()).toContain("Acme hasn't added any models yet");
    });
  });

  it('labels a chat on a removed model plainly once the registry loaded', () => {
    const previousSnapshot = useModelCatalogStore.getState().snapshot;
    const snapshot: ModelRegistrySnapshot = {
      claude: [],
      codex: [],
      ollama: [],
      aliases: {},
    };
    useModelCatalogStore.setState({ snapshot });
    try {
      renderPicker(undefined, {
        browserLayout: 'harnesses',
        currentModel: 'claude-retired-4-0',
      });
      const trigger = document.querySelector(
        '[data-testid="chat-model-picker"]',
      );
      expect(trigger?.textContent).toContain('Model no longer available');
      expect(trigger?.textContent).not.toContain('claude-retired-4-0');
    } finally {
      useModelCatalogStore.setState({ snapshot: previousSnapshot });
    }
  });

  it.each(['loading', 'failed'] as const)(
    'keeps a hosted model name while the hosted list is %s',
    (status) => {
      const previous = useModelCatalogStore.getState();
      const snapshot: ModelRegistrySnapshot = {
        claude: [],
        codex: [],
        ollama: [],
        aliases: {},
        aiGatewayCatalogStatus: status,
      };
      useModelCatalogStore.setState({
        snapshot,
        aiGatewayCatalogStatus: status,
      });
      try {
        renderPicker(undefined, {
          browserLayout: 'harnesses',
          currentModel: 'hosted-model-not-loaded-yet',
        });
        const trigger = document.querySelector(
          '[data-testid="chat-model-picker"]',
        );
        expect(trigger?.textContent).not.toContain('Model no longer available');
      } finally {
        useModelCatalogStore.setState({
          snapshot: previous.snapshot,
          aiGatewayCatalogStatus: previous.aiGatewayCatalogStatus,
        });
      }
    },
  );

  it('asks to sign in, not to open Settings, for a disconnected Claude tab', () => {
    renderPicker(availability({}), { browserLayout: 'harnesses' });
    act(() =>
      document
        .querySelector<HTMLElement>(
          '[data-testid="chat-model-harness-tab-claude"]',
        )
        ?.click(),
    );
    const prompt = document.querySelector(
      '[data-testid="chat-model-connect-prompt"]',
    );
    expect(prompt?.textContent).toContain('Sign in to Claude');
    expect(prompt?.textContent).not.toContain('Settings');
    expect(
      document.querySelector('[data-testid="chat-model-connect-harness"]')
        ?.textContent,
    ).toBe('Sign in');
  });

  it('opens a chat locked to one harness on that harness tab', () => {
    renderPicker(undefined, {
      browserLayout: 'harnesses',
      lockedProvider: 'codex',
      lockedProviderBehavior: 'disabled',
    });
    expect(
      document
        .querySelector('[data-testid="chat-model-harness-tab-codex"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('keeps All for a chat that can continue on another harness', () => {
    renderPicker(undefined, {
      browserLayout: 'harnesses',
      lockedProvider: 'codex',
      lockedProviderBehavior: 'continue',
    });
    expect(
      document
        .querySelector('[data-testid="chat-model-harness-tab-all"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('opens the harness picker on All with leading stars and harness tabs', () => {
    renderPicker(undefined, { browserLayout: 'harnesses' });
    const tab = (id: string): HTMLButtonElement | null =>
      document.querySelector<HTMLButtonElement>(
        `[data-testid="chat-model-harness-tab-${id}"]`,
      );
    expect(tab('all')?.getAttribute('aria-checked')).toBe('true');
    expect(tab('favorites')).not.toBeNull();
    expect(tab('claude')).not.toBeNull();
    expect(tab('codex')).not.toBeNull();
    // Harnesses replace the old per-vendor tabs.
    expect(tab('vendor:deepseek')).toBeNull();
    expect(tab('unstoppable')).toBeNull();
    // The shell fits the rail, but a rail shorter than six tabs keeps the
    // six-tab height so about five models still show.
    const railTabCount = document.querySelectorAll(
      '[data-testid^="chat-model-harness-tab-"]',
    ).length;
    expect(railTabCount).toBeLessThan(6);
    expect(
      document.querySelector<HTMLElement>('[data-testid="chat-model-menu"]')
        ?.style.height,
    ).toBe(`${pickerChromeMenuHeightPx({ railTabCount: 6 })}px`);
    const selected = option(CLAUDE_GATEWAY);
    expect(selected.querySelector('[data-picker-selected-check]')).toBeNull();
    expect(selected.parentElement?.classList.contains('bg-subtle')).toBe(true);
    // Stars lead each row instead of provider glyphs.
    const star = document.querySelector<HTMLElement>(
      `[data-testid="chat-model-favorite-${CLAUDE_GATEWAY}"]:not([hidden])`,
    );
    expect(star?.className).toContain('left-0.5');
  });

  // ModelGroup renders <div>{header}<div className="py-0.5">{options}</div></div>,
  // so an option's grandparent is its group div and the group's first child is
  // the section header. This lets us assert which section a row lives under.
  function groupHeaderTextFor(model: string): string {
    // Read the heading through the section's own `role="group"` rather than a
    // fixed parent depth, so the assertion survives a change to the list's
    // wrapper nesting.
    const group = option(model).closest('[role="group"]');
    return (
      group?.querySelector('[data-testid^="chat-model-group-label-"]')
        ?.textContent ?? ''
    );
  }

  it('groups by vendor with its own brand casing, and badges gateway-only rows', () => {
    renderPicker(undefined);

    for (const model of [CODEX_GATEWAY_ONLY, DEEPSEEK_FLASH]) {
      expect(groupHeaderTextFor(model)).toContain('DeepSeek');
      expect(option(model).textContent).toContain('$');
    }
    for (const model of [KIMI_K2, KIMI_K3]) {
      expect(groupHeaderTextFor(model)).toContain('Moonshot AI');
      expect(option(model).textContent).toContain('$');
    }
    expect(groupHeaderTextFor(GLM)).toContain('Z.ai');
    expect(option(GLM).textContent).toContain('$');
    expect(groupHeaderTextFor(MINIMAX)).toContain('MiniMax');
    expect(option(MINIMAX).textContent).toContain('$');
    // The vendor, not the harness: the heading names who made the model.
    expect(groupHeaderTextFor(CODEX_GATEWAY)).toContain('OpenAI');
    expect(groupHeaderTextFor(CODEX_GATEWAY_ONLY)).not.toBe(
      groupHeaderTextFor(CODEX_GATEWAY),
    );
  });

  it('files fable under its vendor, ahead of Opus, and shows the extra-charge badge', () => {
    renderPicker(undefined);

    // Fable and Opus are both Anthropic models, so they share one heading and
    // order by their declared sortOrder rather than each owning a section.
    expect(groupHeaderTextFor(FABLE_EXTRA_CHARGE)).toContain('Anthropic');
    expect(groupHeaderTextFor(FABLE_EXTRA_CHARGE)).toBe(
      groupHeaderTextFor(CLAUDE_GATEWAY),
    );
    expect(option(FABLE_EXTRA_CHARGE).textContent).toContain('$');
    expect(groupHeaderTextFor(FABLE_EXTRA_CHARGE)).not.toContain(
      brandText.appName,
    );
    expect(
      option(FABLE_EXTRA_CHARGE).compareDocumentPosition(
        option(CLAUDE_GATEWAY),
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps the AI Credits badge and selection indication on selected extra-charge rows', () => {
    render(
      createElement(ModelPicker, {
        currentModel: FABLE_EXTRA_CHARGE,
        onModelChange: (): void => {},
      }),
    );
    openPicker();

    const row = option(FABLE_EXTRA_CHARGE);
    expect(row.getAttribute('aria-checked')).toBe('true');
    expect(row.querySelector('svg')).not.toBeNull();
    expect(
      row.querySelector(
        `[data-testid="chat-model-option-extra-charge-${FABLE_EXTRA_CHARGE}"]`,
      ),
    ).not.toBeNull();
  });
});

describe('ModelPicker AI Credits registry composition', () => {
  function renderedModelIds(): string[] {
    return Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'button[data-testid^="chat-model-option-"]',
      ),
    ).map((el) =>
      (el.getAttribute('data-testid') ?? '').replace('chat-model-option-', ''),
    );
  }

  it('merges API-only registry models with legacy inlined gateway-only ids', () => {
    renderPicker(undefined);
    const ids = renderedModelIds();
    for (const model of [
      GATEWAY_API_CLAUDE,
      CLAUDE_GATEWAY_ONLY,
      CODEX_GATEWAY_ONLY,
      GATEWAY_API_CODEX,
    ]) {
      expect(ids).toContain(model);
    }
  });

  it('dedupes an id present both as an API-only row and a legacy inlined managed row', () => {
    // Same id in AI_GATEWAY_MODELS AND CLAUDE_MODELS (legacy snapshot that
    // inlined the gateway row) must render exactly once, under AI Credits.
    registerModelRegistries([
      ...API_GATEWAY_ENTRIES,
      apiGatewayEntry(CLAUDE_GATEWAY_ONLY, 'Claude Gateway Only', 'claude'),
    ]);
    try {
      renderPicker(undefined);
      expect(
        document.querySelectorAll(
          `[data-testid="chat-model-option-${CLAUDE_GATEWAY_ONLY}"]`,
        ),
      ).toHaveLength(1);
      expect(renderedModelIds()).toContain(CLAUDE_GATEWAY_ONLY);
    } finally {
      registerModelRegistries();
    }
  });

  it('lists account-only Codex models and follows the account list (CAN-4716)', () => {
    renderPicker(undefined);
    expect(renderedModelIds()).not.toContain('gpt-6-free');
    try {
      // The lane sync registers the models, then publishes the id set.
      act(() => {
        setCodexAccountModels([
          { id: 'gpt-6-free', model: 'gpt-6-free', displayName: 'Free 6' },
        ]);
        setRendererCodexAccountModels(new Set(['gpt-6-free']));
      });
      expect(renderedModelIds()).toContain('gpt-6-free');
      expect(
        document.querySelector('[data-testid="chat-model-option-gpt-6-free"]')
          ?.textContent,
      ).toContain('Free 6');
    } finally {
      act(() => {
        clearCodexAccountModels();
        setRendererCodexAccountModels(null);
      });
    }
    expect(renderedModelIds()).not.toContain('gpt-6-free');
  });

  it('renders the shared group headers with their stable test ids', () => {
    renderPicker(undefined);
    // Vendor-keyed since CAN-2701. Rows that declare no vendor share ONE
    // neutral section rather than one per harness, so two headings can never
    // both read "Other models" — and none is filed under a vendor it never
    // claimed. Ollama keeps its own, where the harness is the vendor.
    for (const key of [
      'vendor:unclaimed',
      'provider:ollama',
      'anthropic',
      'deepseek',
    ]) {
      expect(
        document.querySelector(`[data-testid="chat-model-group-label-${key}"]`),
      ).not.toBeNull();
      expect(
        document.querySelector(`[data-testid="chat-model-group-icon-${key}"]`),
      ).not.toBeNull();
    }
  });
});

describe('ModelPicker locked-harness assignment filtering', () => {
  it('keeps an explicitly Claude-harnessed Ollama chat locked to Claude', () => {
    render(
      createElement(ModelPicker, {
        currentModel: OLLAMA_MODEL,
        onModelChange: (): void => {},
        lockedProvider: 'ollama',
        lockedHarness: 'claude',
        ...{ executionHarnessExplicitlyChosen: true },
      }),
    );
    openPicker();
    expect(isDisabled(CLAUDE_GATEWAY)).toBe(false);
    expect(isDisabled(CODEX_GATEWAY)).toBe(true);
    expect(isDisabled(OLLAMA_MODEL)).toBe(false);
  });

  // Both providers fully available (native auth + credits) so the ONLY reason
  // a row can be disabled in these tests is a harness-lock mismatch.
  const bothAvailable = availability({
    claude: {
      selectable: true,
      nativeAuth: true,
      creditsEligible: true,
      loading: false,
    },
    codex: {
      selectable: true,
      nativeAuth: true,
      creditsEligible: true,
      loading: false,
    },
  });

  function gatewayAssignment(
    modelId: string,
    harness: 'claude' | 'codex',
  ): ModelHarnessAssignment {
    return {
      modelId,
      source: 'ai-gateway',
      harness,
      defaultHarness: 'codex',
      configurable: true,
      overridden: harness !== 'codex',
    };
  }

  function renderLocked(lockedHarness: 'claude' | 'codex'): void {
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: (): void => {},
        lockedHarness,
        providerAvailability: bothAvailable,
      }),
    );
    openPicker();
  }

  function remount(): void {
    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';
  }

  it('keeps the trigger logo pinned to the captured harness after the assignment changes', () => {
    initModelHarnessAssignments({
      revision: 2,
      assignments: [gatewayAssignment(GATEWAY_API_CODEX, 'claude')],
    });
    render(
      createElement(ModelPicker, {
        currentModel: GATEWAY_API_CODEX,
        onModelChange: (): void => {},
        lockedHarness: 'codex',
        providerAvailability: bothAvailable,
      }),
    );

    expect(
      document
        .querySelector('[data-testid="chat-model-picker-provider-icon"]')
        ?.getAttribute('data-provider'),
    ).toBe('codex');
  });

  it('enables a codex-assigned gateway model under a codex lock alongside managed codex rows', () => {
    initModelHarnessAssignments({
      revision: 1,
      assignments: [gatewayAssignment(GATEWAY_API_CODEX, 'codex')],
    });
    renderLocked('codex');
    // Configurable gateway row and managed codex row share the locked harness.
    expect(isDisabled(GATEWAY_API_CODEX)).toBe(false);
    expect(isDisabled(CODEX_GATEWAY)).toBe(false);
    // Claude-harness rows are locked out even though Claude is available.
    expect(isDisabled(CLAUDE_GATEWAY)).toBe(true);
  });

  it('flips the same model when the snapshot moves it to the claude harness', () => {
    initModelHarnessAssignments({
      revision: 2,
      assignments: [gatewayAssignment(GATEWAY_API_CODEX, 'claude')],
    });
    renderLocked('codex');
    expect(isDisabled(GATEWAY_API_CODEX)).toBe(true);

    remount();
    renderLocked('claude');
    expect(isDisabled(GATEWAY_API_CODEX)).toBe(false);
  });

  it('falls back to provider-derived harnesses when the snapshot is empty', () => {
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    renderLocked('codex');
    // Ollama rows fall back to DEFAULT_OLLAMA_HARNESS (codex)…
    expect(DEFAULT_OLLAMA_HARNESS).toBe('codex');
    expect(isDisabled(OLLAMA_MODEL)).toBe(false);
    // …and gateway rows fall back to their recommended harness.
    expect(isDisabled(GATEWAY_API_CODEX)).toBe(false);
    expect(isDisabled(GATEWAY_API_CLAUDE)).toBe(true);

    remount();
    renderLocked('claude');
    expect(isDisabled(OLLAMA_MODEL)).toBe(true);
    expect(isDisabled(GATEWAY_API_CODEX)).toBe(true);
    expect(isDisabled(GATEWAY_API_CLAUDE)).toBe(false);
  });
});

function billingGroup(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="chat-billing-framework"]',
  );
}

function billingSwitch(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    '[data-testid="chat-billing-framework"]',
  );
  if (!el) throw new Error('billing switch not found');
  return el;
}

function renderBillingPicker(input: {
  currentModel: string;
  value: 'subscription' | 'ai-credits';
  onChange?: (framework: 'subscription' | 'ai-credits') => void;
  disabled?: boolean;
  lockedReason?: string;
  lockKind?: ChatBillingResolution['lockKind'];
  browserLayout?: 'harnesses';
}): void {
  render(
    createElement(ModelPicker, {
      currentModel: input.currentModel,
      onModelChange: () => {},
      browserLayout: input.browserLayout,
      billing: {
        value: input.value,
        onChange: input.onChange ?? ((): void => {}),
        provider: providerForModel(input.currentModel),
        ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
        ...(input.lockedReason !== undefined
          ? { lockedReason: input.lockedReason }
          : {}),
        ...(input.lockKind !== undefined ? { lockKind: input.lockKind } : {}),
      },
    }),
  );
  openPicker();
}

function signInCta(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    '[data-testid="chat-billing-sign-in"]',
  );
}

describe('ModelPicker billing framework toggle', () => {
  it('omits the legacy billing footer in the harness picker', () => {
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'subscription',
      disabled: true,
      lockedReason: 'This model can’t bill to AI Credits.',
      browserLayout: 'harnesses',
    });
    expect(billingGroup()).toBeNull();
    expect(
      document.querySelector('[data-testid="chat-billing-locked-reason"]'),
    ).toBeNull();
    expect(isAbsent(CODEX_GATEWAY)).toBe(false);
  });

  it('hides the toggle when no billing prop is provided', () => {
    renderPicker(undefined);
    expect(billingGroup()).toBeNull();
  });

  it('renders a single AI Credits switch', () => {
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'subscription',
    });
    const sw = billingSwitch();
    expect(sw.getAttribute('role')).toBe('menuitemcheckbox');
    // Verb-framed label distinguishes the chat-wide billing switch from the
    // branded model-group header (which keeps the BrandLogo icon); the switch
    // deliberately drops that icon so it doesn't read as a duplicate group.
    expect(sw.textContent).toContain('Use AI Credits');
  });

  it('surfaces a discovery tooltip on hover', () => {
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'subscription',
    });
    const tooltip = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(
        '[data-testid="chat-billing-tooltip"]',
      );

    // Hidden until hovered.
    expect(tooltip()).toBeNull();

    // The RichHoverTooltip wrapper owns the hover handlers; React synthesizes
    // onMouseEnter from a bubbling mouseover on the trigger button.
    act(() => {
      billingSwitch().dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    // Tooltip reflects the current (off/subscription) state.
    expect(tooltip()?.textContent).toContain(
      'Currently billing to your subscription',
    );
  });

  it('reflects the current framework in the tooltip when on', () => {
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'ai-credits',
    });
    act(() => {
      billingSwitch().dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    expect(
      document.querySelector<HTMLElement>(
        '[data-testid="chat-billing-tooltip"]',
      )?.textContent,
    ).toContain('Currently billing to AI Credits');
  });

  it('reflects the selected framework via aria-checked', () => {
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'subscription',
    });
    expect(billingSwitch().getAttribute('aria-checked')).toBe('false');

    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';

    renderBillingPicker({ currentModel: CLAUDE_GATEWAY, value: 'ai-credits' });
    expect(billingSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('toggles to the opposite framework on click', () => {
    const onChange = jest.fn();
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'subscription',
      onChange,
    });
    act(() => {
      billingSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('ai-credits');

    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';

    const onChangeFromCredits = jest.fn();
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'ai-credits',
      onChange: onChangeFromCredits,
    });
    act(() => {
      billingSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChangeFromCredits).toHaveBeenCalledWith('subscription');
  });

  it('hides non-gateway-routable rows under AI Credits and restores them under subscription', () => {
    // CAN-2349 case E. These rows were greyed; dimming a row the user cannot
    // act on in ANY way is pure noise, so they are hidden instead and the count
    // note under the toggle is what says they exist.
    renderBillingPicker({ currentModel: CLAUDE_GATEWAY, value: 'ai-credits' });
    expect(isDisabled(CLAUDE_GATEWAY)).toBe(false);
    expect(isAbsent(CLAUDE_NON_GATEWAY)).toBe(true);
    expect(isAbsent(CODEX_NON_GATEWAY)).toBe(true);

    const note = document.querySelector(
      '[data-testid="chat-billing-hidden-count"]',
    );
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain('hidden');

    // Ollama is the exception and KEEPS its group. Local models are never
    // gateway-routable, so they used to fall into this filter with everything
    // else — but routability is not a question a free local model can fail,
    // and hiding it here contradicts both `resolveChatBillingFramework`
    // ("Ollama is local/free and never carries a billing concept") and case A's
    // own Ollama carve-out. It also stranded users in locked-billing states:
    // the note could name a toggle they cannot operate while local models
    // simply left the picker.
    expect(
      document.querySelector(
        '[data-testid="chat-model-group-label-provider:ollama"]',
      ),
    ).not.toBeNull();

    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';

    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'subscription',
    });
    expect(isDisabled(CLAUDE_NON_GATEWAY)).toBe(false);
    expect(isDisabled(CODEX_NON_GATEWAY)).toBe(false);
    expect(
      document.querySelector('[data-testid="chat-billing-hidden-count"]'),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="chat-model-group-label-provider:ollama"]',
      ),
    ).not.toBeNull();
  });

  it('drops a group header when AI Credits hide every row in it', () => {
    // Direct coverage for the empty-group filter this PR introduced.
    //
    // The Ollama group used to provide it incidentally, because case E hid
    // local models too. Now that Ollama is correctly exempt from a billing
    // question, no fixture group empties on its own — so a change that hides
    // rows but forgets the header filter would pass the entire suite. Narrow
    // the vendorless rows to a single non-routable model to construct the case
    // explicitly. Since CAN-2701 every row that declares no vendor shares ONE
    // "Other models" section, so that means dropping the API-only gateway
    // entries AND the vendorless Claude rows, which would otherwise keep the
    // section alive; `finally` restores everything so nothing leaks.
    registerModelRegistries([]);
    initClaudeModels([{ id: CLAUDE_GATEWAY, label: 'Opus' }]);
    initCodexModels([{ id: CODEX_NON_GATEWAY, label: 'Codex Legacy' }]);
    try {
      renderBillingPicker({
        currentModel: CLAUDE_GATEWAY,
        value: 'ai-credits',
      });

      expect(isAbsent(CODEX_NON_GATEWAY)).toBe(true);
      // Its only row is hidden, so the whole section goes with it.
      expect(
        document.querySelector(
          '[data-testid="chat-model-group-label-vendor:unclaimed"]',
        ),
      ).toBeNull();
      // Anthropic still has routable rows, so its header stays — this is the
      // filter working, not the whole list collapsing.
      expect(
        document.querySelector(
          '[data-testid="chat-model-group-label-anthropic"]',
        ),
      ).not.toBeNull();
    } finally {
      registerModelRegistries();
    }
  });

  it('keeps the current model visible even when AI Credits cannot route it', () => {
    // Guard, not a normal state: `resolveChatBillingFramework` already locks
    // the toggle OFF for a non-routable selection. Without the short-circuit,
    // one bad state makes the checked row vanish and the picker shows no
    // selection at all.
    renderBillingPicker({
      currentModel: CLAUDE_NON_GATEWAY,
      value: 'ai-credits',
    });
    expect(isAbsent(CLAUDE_NON_GATEWAY)).toBe(false);
    expect(option(CLAUDE_NON_GATEWAY).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('offers a Get AI Credits CTA for a no-credits lock but not for model-not-routable', () => {
    // Case C: `'no-credits'` is account state the user can fix, so the same
    // shared CTA the modal uses appears beside the sign-in CTA.
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'subscription',
      disabled: true,
      lockedReason: 'No AI Credits available.',
      lockKind: 'no-credits',
    });
    expect(
      document.querySelector('[data-testid="chat-billing-get-credits"]'),
    ).not.toBeNull();

    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';

    // Case D: a property of the MODEL, not the account. No purchase changes it,
    // so offering one would be a lie.
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'subscription',
      disabled: true,
      lockedReason: 'This model cannot be routed to AI Credits.',
      lockKind: 'model-not-routable',
    });
    expect(
      document.querySelector('[data-testid="chat-billing-get-credits"]'),
    ).toBeNull();
  });

  it('escalates a contact-admin no-credits lock into the recovery modal', async () => {
    const onChange = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadNativeAiCreditsAvailability: jest.fn().mockResolvedValue({
          personalEligible: false,
          orgSpendable: false,
          inOrg: true,
          orgCreditPoolCovered: true,
          inconclusive: false,
          pricingUrl: 'https://example.test/pricing',
        }),
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          account: { id: 'acct_1' },
          authMode: 'account',
          credentialSource: 'account',
          orgBillingStates: [],
        }),
      },
    });
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'subscription',
      disabled: true,
      lockedReason: 'No AI Credits available.',
      lockKind: 'no-credits',
      onChange,
    });

    await act(async () => {
      document
        .querySelector('[data-testid="chat-billing-get-credits"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(recoveryModal()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-contact-admin"]'),
    ).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('buys in the browser even when Settings could open, keeping Check again in the menu (CAN-5160)', async () => {
    const realOpenAccountOrganizationSettings =
      useNavigationStore.getState().openAccountOrganizationSettings;
    const openAccountOrganizationSettings = jest.fn<
      void,
      [SettingsRoute, unknown?]
    >();
    const openAuthenticatedPortalPage = jest.fn().mockResolvedValue(true);
    useNavigationStore.setState({ openAccountOrganizationSettings });
    mockHostedSettingsOpenable.mockReturnValue(true);
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadNativeAiCreditsAvailability: jest.fn().mockResolvedValue({
          personalEligible: false,
          orgSpendable: false,
          inOrg: false,
          orgCreditPoolCovered: false,
          inconclusive: false,
          pricingUrl: 'https://example.test/pricing',
        }),
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          account: { id: 'acct_1' },
          authMode: 'account',
          credentialSource: 'account',
          orgBillingStates: [],
        }),
        openAuthenticatedPortalPage,
        browser: { openExternal: jest.fn().mockResolvedValue(undefined) },
      },
    });
    try {
      renderBillingPicker({
        currentModel: CLAUDE_GATEWAY,
        value: 'subscription',
        disabled: true,
        lockedReason: 'No AI Credits available.',
        lockKind: 'no-credits',
      });
      expect(
        document.querySelector('[data-testid="chat-model-menu"]'),
      ).not.toBeNull();

      await act(async () => {
        document
          .querySelector('[data-testid="chat-billing-get-credits"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });

      // Settings would end the hand-off, so the composer could never confirm
      // the credits; the chat banners take the browser for the same reason.
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
      expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
      expect(recoveryModal()).toBeNull();
      expect(
        document.querySelector(
          '[data-testid="chat-billing-get-credits-check-again"]',
        ),
      ).not.toBeNull();
    } finally {
      mockHostedSettingsOpenable.mockReturnValue(false);
      useNavigationStore.setState({
        openAccountOrganizationSettings: realOpenAccountOrganizationSettings,
      });
    }
  });

  it('Guard 3: drops a pending recovery whose row is PERMANENTLY blocked', async () => {
    // Guard 2 only sees a row that LEFT the list. A row that stays listed but
    // degrades to a permanent `hard-disabled` (org policy, or an Agent whose
    // base model left the registry) passes `stillListed`, so without Guard 3 a
    // later coverage or sign-in success commits a model the picker itself would
    // now refuse to select.
    const onModelChange = jest.fn();
    const loadNativeAiCreditsAvailability = jest.fn().mockResolvedValue({
      personalEligible: false,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: true,
      pricingUrl: 'https://example.test/pricing',
    });
    const loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'account',
      credentialSource: 'account',
      orgBillingStates: [],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability, loadCanopyCloudAccount },
    });

    renderPicker(availability({}), {
      onModelChange,
      currentModel: CLAUDE_NON_GATEWAY,
    });

    await act(async () => {
      option(CLAUDE_GATEWAY).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(recoveryModal()).not.toBeNull();

    // The org's model policy starts blocking it while the modal is open. The
    // row is still rendered — just permanently unselectable now.
    // Keyed by GATEWAY id: `isModelBlocked` normalizes a model to its
    // `gatewayId` before consulting the policy, so a set holding the bare
    // `'opus'` would silently match nothing and prove nothing. The id is the
    // one this file's `gatewayRoute` fixture registers for CLAUDE_GATEWAY.
    await act(async () => {
      useModelCatalogStore.setState({
        policy: new Set<string>([`vendor/${CLAUDE_GATEWAY}`]),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(recoveryModal()).toBeNull();
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('Guard 3 does NOT cancel a recovery for a TRANSIENT provider lock', async () => {
    // `hard-disabled` is not the same set as "permanently unselectable".
    // `ChatInput` derives `lockedProviderBehavior` from `continueEligibility.ok`,
    // which goes false merely because a turn is streaming, a turn is queued, or
    // a plan is awaiting approval — the gate's own copy says "stop the current
    // turn, then switch". If Guard 3 fired on that, a queued turn starting
    // while the user is off in the browser signing in would cancel their
    // recovery and unmount the AuthLoginModal they are using, leaving them to
    // come back to nothing.
    const onModelChange = jest.fn();
    const loadNativeAiCreditsAvailability = jest.fn().mockResolvedValue({
      personalEligible: false,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: true,
      pricingUrl: 'https://example.test/pricing',
    });
    const loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'account',
      credentialSource: 'account',
      orgBillingStates: [],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability, loadCanopyCloudAccount },
    });

    const pickerFor = (locked: boolean): ReactNode =>
      createElement(ModelPicker, {
        currentModel: CLAUDE_NON_GATEWAY,
        onModelChange,
        providerAvailability: availability({}),
        ...(locked
          ? {
              lockedProvider: 'codex',
              lockedProviderBehavior: 'disabled',
              lockedProviderReason: 'This chat is locked to Codex.',
            }
          : {}),
      });

    root = createRoot(document.body);
    act(() => {
      root?.render(pickerFor(false));
    });
    openPicker();

    await act(async () => {
      option(CLAUDE_GATEWAY).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(recoveryModal()).not.toBeNull();

    // A turn starts while the user is away signing in, so the chat locks to the
    // other harness. This is temporary — it clears when the turn ends.
    await act(async () => {
      root?.render(pickerFor(true));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The recovery MUST survive it.
    expect(recoveryModal()).not.toBeNull();
  });

  it('refuses the commit while the row is still provider-locked, and says why', async () => {
    // The other half of the transient-lock decision above. Keeping the recovery
    // alive through the lock means the commit can arrive WHILE the lock is
    // still on, and `ChatInput.handleModelChange` only routes to the visible
    // continue dialog while `continueEligibility.ok` — a lock caused by a
    // streaming or queued turn falls through to `setModel`, whose `changeModel`
    // IPC answers `accepted: false` and drops the change with no UI at all.
    //
    // So a successful recovery here must NOT close the modal over a change that
    // never lands. It refuses, keeps the (already successful) recovery alive,
    // and shows the row's own lock reason so the user can clear it and retry.
    const onModelChange = jest.fn();
    const loadNativeAiCreditsAvailability = jest.fn().mockResolvedValue({
      personalEligible: false,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: true,
      pricingUrl: 'https://example.test/pricing',
    });
    const loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'account',
      credentialSource: 'account',
      orgBillingStates: [],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability, loadCanopyCloudAccount },
    });

    // Stands in for main: `changeModel` refuses a cross-provider change while
    // the ORIGINATING chat is locked, and `ChatInput` surfaces that verdict
    // through `onRecoveryCommit`. This — not the rendered rows — is what
    // decides the refusal.
    let mainAccepts = true;
    const onRecoveryCommit = jest.fn((model: ChatModel) => {
      if (!mainAccepts) return Promise.resolve(false);
      onModelChange(model);
      return Promise.resolve(true);
    });

    const pickerFor = (locked: boolean): ReactNode =>
      createElement(ModelPicker, {
        currentModel: CLAUDE_NON_GATEWAY,
        onModelChange,
        onRecoveryCommit,
        recoveryChatKey: 'chat-a',
        providerAvailability: availability({}),
        ...(locked
          ? {
              lockedProvider: 'codex',
              lockedProviderBehavior: 'disabled',
              lockedProviderReason: 'This chat is locked to Codex.',
            }
          : {}),
      });

    root = createRoot(document.body);
    act(() => {
      root?.render(pickerFor(false));
    });
    openPicker();

    await act(async () => {
      option(CLAUDE_GATEWAY).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(recoveryModal()).not.toBeNull();

    // A queued turn locks the chat to the other harness while the user is away,
    // and main starts refusing.
    mainAccepts = false;
    await act(async () => {
      root?.render(pickerFor(true));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Their credits land and they press Try again. The recovery SUCCEEDS.
    loadNativeAiCreditsAvailability.mockResolvedValue({
      personalEligible: true,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: false,
      pricingUrl: 'https://example.test/pricing',
    });
    await act(async () => {
      document
        .querySelector('[data-testid="model-recovery-try-again"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Refused, not silently dropped: no model change, modal still up, and the
    // row's own lock copy explaining what the user has to clear.
    expect(onModelChange).not.toHaveBeenCalled();
    expect(recoveryModal()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-commit-blocked"]')
        ?.textContent,
    ).toContain('This chat is locked to Codex.');

    // The turn ends, main accepts again, and the SAME button now commits — the
    // refusal must not have latched the modal's commit-at-most-once guard.
    mainAccepts = true;
    await act(async () => {
      root?.render(pickerFor(false));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector('[data-testid="model-recovery-commit-retry"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onModelChange).toHaveBeenCalledWith(CLAUDE_GATEWAY);
  });

  it('judges the commit by the ORIGINATING chat, not the rendered rows', async () => {
    // This component survives a chat-tab switch on some surfaces
    // (CodeReviewModal), and after one the rendered rows describe the NEW chat
    // while the recovery still commits to the original. Deciding the refusal
    // from those rows would block a perfectly valid commit on the strength of a
    // lock belonging to someone else.
    //
    // So the verdict comes from `onRecoveryCommit`, which `ChatInput` routes
    // through `setModelAndWait` — main's answer about the ORIGINATING chat.
    // Here chat B is locked and chat A is not, and the commit must still land.
    const onModelChange = jest.fn();
    const loadNativeAiCreditsAvailability = jest.fn().mockResolvedValue({
      personalEligible: false,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: true,
      pricingUrl: 'https://example.test/pricing',
    });
    const loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'account',
      credentialSource: 'account',
      orgBillingStates: [],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability, loadCanopyCloudAccount },
    });

    // Chat A is unlocked in main, so its commit is accepted regardless of what
    // chat B's rows look like.
    const onRecoveryCommit = jest.fn((model: ChatModel) => {
      onModelChange(model);
      return Promise.resolve(true);
    });

    const pickerFor = (chatKey: string, locked: boolean): ReactNode =>
      createElement(ModelPicker, {
        currentModel: CLAUDE_NON_GATEWAY,
        onModelChange,
        onRecoveryCommit,
        providerAvailability: availability({}),
        recoveryChatKey: chatKey,
        ...(locked
          ? {
              lockedProvider: 'codex',
              lockedProviderBehavior: 'disabled',
              lockedProviderReason: 'This chat is locked to Codex.',
            }
          : {}),
      });

    // Recovery starts on chat A, which is NOT locked.
    root = createRoot(document.body);
    act(() => {
      root?.render(pickerFor('chat-a', false));
    });
    openPicker();

    await act(async () => {
      option(CLAUDE_GATEWAY).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(recoveryModal()).not.toBeNull();

    // The user switches to chat B, which IS locked. These rows say
    // "locked-provider" but they describe a chat the recovery has nothing to
    // do with.
    await act(async () => {
      root?.render(pickerFor('chat-b', true));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Credits land; the commit must go through to chat A, NOT be refused on
    // chat B's lock.
    loadNativeAiCreditsAvailability.mockResolvedValue({
      personalEligible: true,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: false,
      pricingUrl: 'https://example.test/pricing',
    });
    await act(async () => {
      document
        .querySelector('[data-testid="model-recovery-try-again"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onModelChange).toHaveBeenCalledWith(CLAUDE_GATEWAY);
    // The recovery's own commit was used, bound to chat A.
    expect(onRecoveryCommit).toHaveBeenCalledWith(CLAUDE_GATEWAY);
    expect(
      document.querySelector('[data-testid="model-recovery-commit-blocked"]'),
    ).toBeNull();
  });

  it('catches a lock on the ORIGINATING chat even when the rendered rows look fine', async () => {
    // The half the chat-key guard could not close, and the reason the commit
    // now reports acceptance instead of being inferred.
    //
    // The user starts a recovery on chat A, switches to chat B, and a turn
    // begins on A. B's rows are perfectly selectable, so nothing the picker can
    // SEE says anything is wrong — yet committing to A is refused by main.
    // Before the async outcome that refusal arrived as silence: the modal
    // closed reporting success and the model change was dropped.
    const onModelChange = jest.fn();
    const loadNativeAiCreditsAvailability = jest.fn().mockResolvedValue({
      personalEligible: false,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: true,
      pricingUrl: 'https://example.test/pricing',
    });
    const loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'account',
      credentialSource: 'account',
      orgBillingStates: [],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability, loadCanopyCloudAccount },
    });

    // Main refuses: chat A is locked. Chat B's props say nothing about it.
    const onRecoveryCommit = jest.fn(() => Promise.resolve(false));

    const pickerFor = (chatKey: string): ReactNode =>
      createElement(ModelPicker, {
        currentModel: CLAUDE_NON_GATEWAY,
        onModelChange,
        onRecoveryCommit,
        recoveryChatKey: chatKey,
        providerAvailability: availability({}),
      });

    root = createRoot(document.body);
    act(() => {
      root?.render(pickerFor('chat-a'));
    });
    openPicker();

    await act(async () => {
      option(CLAUDE_GATEWAY).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(recoveryModal()).not.toBeNull();

    // Switch to chat B — unlocked, so no row here can hint at A's state.
    await act(async () => {
      root?.render(pickerFor('chat-b'));
      await Promise.resolve();
      await Promise.resolve();
    });

    loadNativeAiCreditsAvailability.mockResolvedValue({
      personalEligible: true,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: false,
      pricingUrl: 'https://example.test/pricing',
    });
    await act(async () => {
      document
        .querySelector('[data-testid="model-recovery-try-again"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Refused, and SAID so — not closed over a change that never landed.
    expect(onRecoveryCommit).toHaveBeenCalledWith(CLAUDE_GATEWAY);
    expect(onModelChange).not.toHaveBeenCalled();
    expect(recoveryModal()).not.toBeNull();
    // No row to quote (we are showing chat B), so the generic reason.
    expect(
      document.querySelector('[data-testid="model-recovery-commit-blocked"]')
        ?.textContent,
    ).toContain('couldn’t switch models');
  });

  it('does not restore focus when Cancel lands while the commit is in flight', async () => {
    // `ModelRecoveryModal` auto-commits from inside its own account re-read
    // while still rendering an ENABLED Cancel, so the user can tear the
    // recovery down mid-IPC. The commit is already on the wire and will land,
    // but the continuation must not: `onRestoreFocus` would pull the caret into
    // the composer seconds after the user moved on.
    const onModelChange = jest.fn();
    const onRestoreFocus = jest.fn();
    let settleCommit: ((accepted: boolean) => void) | undefined;
    const onRecoveryCommit = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settleCommit = resolve;
        }),
    );
    const loadNativeAiCreditsAvailability = jest.fn().mockResolvedValue({
      personalEligible: true,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: false,
      pricingUrl: 'https://example.test/pricing',
    });
    const loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'account',
      credentialSource: 'account',
      orgBillingStates: [],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability, loadCanopyCloudAccount },
    });

    root = createRoot(document.body);
    act(() => {
      root?.render(
        createElement(ModelPicker, {
          currentModel: CLAUDE_NON_GATEWAY,
          onModelChange,
          onRecoveryCommit,
          onRestoreFocus,
          providerAvailability: availability({}),
        }),
      );
    });
    openPicker();

    await act(async () => {
      option(CLAUDE_GATEWAY).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The auto-commit is in flight and Cancel is still live.
    expect(onRecoveryCommit).toHaveBeenCalledWith(CLAUDE_GATEWAY);
    onRestoreFocus.mockClear();

    await act(async () => {
      document
        .querySelector(
          '[data-testid="model-recovery-modal"] button[aria-label="Close"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    // The user-driven cancel restores focus itself; that is expected and is not
    // what this guards.
    onRestoreFocus.mockClear();

    await act(async () => {
      settleCommit?.(true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onRestoreFocus).not.toHaveBeenCalled();
  });

  it('Guard 3 does NOT cancel a recovery whose row becomes selectable', async () => {
    // The inverse hazard, and the more dangerous one. A gate that stops being
    // `recoverable` because it became `selectable` means the recovery
    // SUCCEEDED — credits landed, the login went through — and that is exactly
    // when the pending commit has to be allowed to fire. A Guard 3 written as
    // "clear when no longer recoverable" would silently cancel every successful
    // recovery, which is the dead end this ticket exists to remove.
    const onModelChange = jest.fn();
    const loadNativeAiCreditsAvailability = jest.fn().mockResolvedValue({
      personalEligible: false,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: true,
      pricingUrl: 'https://example.test/pricing',
    });
    const loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'account',
      credentialSource: 'account',
      orgBillingStates: [],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability, loadCanopyCloudAccount },
    });

    renderPicker(availability({}), {
      onModelChange,
      currentModel: CLAUDE_NON_GATEWAY,
    });

    await act(async () => {
      option(CLAUDE_GATEWAY).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(recoveryModal()).not.toBeNull();

    // Credits land; Try again confirms coverage and the commit must land.
    loadNativeAiCreditsAvailability.mockResolvedValue({
      personalEligible: true,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: false,
      pricingUrl: 'https://example.test/pricing',
    });
    await act(async () => {
      document
        .querySelector('[data-testid="model-recovery-try-again"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onModelChange).toHaveBeenCalledWith(CLAUDE_GATEWAY);
  });

  it('commits row recovery to the chat that STARTED it, not the newly active one', async () => {
    // Recovery is asynchronous (sign-in, purchase, Try again) and this picker
    // survives a chat-tab switch on some surfaces (CodeReviewModal), where
    // `onModelChange` is rebuilt around the current chat. Committing through
    // the LIVE prop selects the recovered model on whichever chat happens to be
    // active when the user finishes — not the row they actually clicked.
    const originatingOnModelChange = jest.fn();
    const otherChatOnModelChange = jest.fn();
    const loadNativeAiCreditsAvailability = jest.fn().mockResolvedValue({
      personalEligible: false,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: true,
      pricingUrl: 'https://example.test/pricing',
    });
    const loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'account',
      credentialSource: 'account',
      orgBillingStates: [],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability, loadCanopyCloudAccount },
    });

    const pickerFor = (onModelChange: (model: string) => void): ReactNode =>
      createElement(ModelPicker, {
        currentModel: CLAUDE_NON_GATEWAY,
        onModelChange,
        providerAvailability: availability({}),
      });

    root = createRoot(document.body);
    act(() => {
      root?.render(pickerFor(originatingOnModelChange));
    });
    openPicker();

    // Click a recoverable row — the inconclusive read keeps the modal open.
    await act(async () => {
      option(CLAUDE_GATEWAY).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(recoveryModal()).not.toBeNull();

    // The user switches chats while the modal is open.
    await act(async () => {
      root?.render(pickerFor(otherChatOnModelChange));
      await Promise.resolve();
    });

    // Credits land and Try again confirms coverage.
    loadNativeAiCreditsAvailability.mockResolvedValue({
      personalEligible: true,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: false,
      pricingUrl: 'https://example.test/pricing',
    });
    await act(async () => {
      document
        .querySelector('[data-testid="model-recovery-try-again"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(originatingOnModelChange).toHaveBeenCalledWith(CLAUDE_GATEWAY);
    expect(otherChatOnModelChange).not.toHaveBeenCalled();
  });

  it('applies a credits recovery to the chat that STARTED it, not whichever billing prop returns', async () => {
    // Two failure modes in one flow:
    //   1. `ChatInput` omits `billing` while a provider availability read is in
    //      flight, and this recovery can complete inside that window. Dropping
    //      the change there lets a completed purchase land with NO visible
    //      effect — the dead end the recovery modal exists to remove.
    //   2. `billing.onChange` is rebuilt around the CURRENT chat, and surfaces
    //      like CodeReviewModal keep this component mounted across a chat
    //      switch — so applying "whatever `billing` shows up next" could enable
    //      paid credit routing on a different chat than the user was fixing.
    const onChange = jest.fn();
    const otherChatOnChange = jest.fn();
    const loadNativeAiCreditsAvailability = jest.fn().mockResolvedValue({
      personalEligible: false,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: true,
      pricingUrl: 'https://example.test/pricing',
    });
    const loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'account',
      credentialSource: 'account',
      orgBillingStates: [],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability, loadCanopyCloudAccount },
    });

    const billingProp = {
      value: 'subscription' as const,
      onChange,
      provider: providerForModel(CLAUDE_GATEWAY),
      disabled: true,
      lockedReason: 'No AI Credits available.',
      lockKind: 'no-credits' as const,
    };
    const pickerWith = (withBilling: boolean): ReactNode =>
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: () => {},
        ...(withBilling ? { billing: billingProp } : {}),
      });

    root = createRoot(document.body);
    act(() => {
      root?.render(pickerWith(true));
    });
    openPicker();

    // An inconclusive read escalates into the modal (§7 — never assert "you
    // have no credits" from a read that did not resolve).
    await act(async () => {
      document
        .querySelector('[data-testid="chat-billing-get-credits"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(recoveryModal()).not.toBeNull();

    // The provider read starts; `billing` disappears from under the picker.
    await act(async () => {
      root?.render(pickerWith(false));
      await Promise.resolve();
    });

    // Credits land, and Try again confirms coverage — the modal commits.
    loadNativeAiCreditsAvailability.mockResolvedValue({
      personalEligible: true,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: false,
      pricingUrl: 'https://example.test/pricing',
    });
    await act(async () => {
      document
        .querySelector('[data-testid="model-recovery-try-again"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The originating chat's toggle is flipped even though the prop was gone.
    expect(onChange).toHaveBeenCalledWith('ai-credits');

    // A DIFFERENT chat's billing prop arrives afterwards. It must not inherit
    // the recovery that belonged to the previous chat.
    await act(async () => {
      root?.render(
        createElement(ModelPicker, {
          currentModel: CLAUDE_GATEWAY,
          onModelChange: () => {},
          billing: { ...billingProp, onChange: otherChatOnChange },
        }),
      );
      await Promise.resolve();
    });

    expect(otherChatOnChange).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('renders a locked-ON gateway-only toggle with its reason and no-ops on click', () => {
    const onChange = jest.fn();
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'ai-credits',
      disabled: true,
      lockedReason: 'This model is only available through AI Credits',
      onChange,
    });

    const sw = billingSwitch();
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('aria-disabled')).toBe('true');
    expect(sw.disabled).toBe(true);

    const reason = document.querySelector(
      '[data-testid="chat-billing-locked-reason"]',
    );
    expect(reason?.textContent).toContain(
      'This model is only available through AI Credits',
    );

    act(() => {
      sw.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders a locked-OFF native-only toggle with its reason and no-ops on click', () => {
    const onChange = jest.fn();
    renderBillingPicker({
      currentModel: CLAUDE_NON_GATEWAY,
      value: 'subscription',
      disabled: true,
      lockedReason: "This model can't bill to AI Credits",
      onChange,
    });

    const sw = billingSwitch();
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.disabled).toBe(true);
    expect(
      document.querySelector('[data-testid="chat-billing-locked-reason"]')
        ?.textContent,
    ).toContain("This model can't bill to AI Credits");

    act(() => {
      sw.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stays interactive with no locked-reason line when both paths are available', () => {
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'subscription',
    });
    const sw = billingSwitch();
    expect(sw.disabled).toBe(false);
    expect(
      document.querySelector('[data-testid="chat-billing-locked-reason"]'),
    ).toBeNull();
  });

  it('renders the Sign-in CTA only for a no-native-login locked toggle', () => {
    // gateway-only lock: no Sign-in CTA (signing in wouldn't help).
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'ai-credits',
      disabled: true,
      lockedReason: 'This model is only available with AI Credits',
      lockKind: 'gateway-only-model',
    });
    expect(signInCta()).toBeNull();

    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';

    // no-native-login lock: the Sign-in CTA renders for the chat's provider.
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'ai-credits',
      disabled: true,
      lockedReason:
        "You're not signed in to Claude, so this chat bills to your AI Credits. Sign in to bill your subscription.",
      lockKind: 'no-native-login',
    });
    const cta = signInCta();
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toContain('Sign in to Claude');
  });

  it('closes the picker dropdown and opens AuthLoginModal when the Sign-in CTA is clicked', () => {
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'ai-credits',
      disabled: true,
      lockedReason:
        "You're not signed in to Claude, so this chat bills to your AI Credits. Sign in to bill your subscription.",
      lockKind: 'no-native-login',
    });

    // Dropdown is open (the billing switch is only rendered inside the menu),
    // and the modal is not yet mounted.
    expect(billingGroup()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="auth-login-modal"]'),
    ).toBeNull();

    const cta = signInCta();
    expect(cta).not.toBeNull();
    act(() => {
      cta?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The dropdown closed (so the menu no longer lingers behind the modal),
    // while the modal — rendered at the picker root, outside the menu portal —
    // opened for the chat's provider.
    expect(billingGroup()).toBeNull();
    const modal = document.querySelector<HTMLElement>(
      '[data-testid="auth-login-modal"]',
    );
    expect(modal).not.toBeNull();
    expect(modal?.getAttribute('data-provider')).toBe('claude');
  });

  it('keeps AuthLoginModal mounted while provider availability refreshes', () => {
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'ai-credits',
      disabled: true,
      lockedReason:
        "You're not signed in to Claude, so this chat bills to your AI Credits. Sign in to bill your subscription.",
      lockKind: 'no-native-login',
    });

    act(() => {
      signInCta()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      document.querySelector('[data-testid="auth-login-modal"]'),
    ).not.toBeNull();

    // AuthLoginModal invalidates the provider cache before each fresh probe.
    // During that loading window ChatInput temporarily omits `billing`; the
    // already-open modal must survive rather than unmounting and remounting in
    // a loop as each probe starts and settles.
    act(() => {
      root?.render(
        createElement(ModelPicker, {
          currentModel: CLAUDE_GATEWAY,
          onModelChange: (): void => {},
        }),
      );
    });

    const modal = document.querySelector<HTMLElement>(
      '[data-testid="auth-login-modal"]',
    );
    expect(modal).not.toBeNull();
    expect(modal?.getAttribute('data-provider')).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// Agents group.
// ---------------------------------------------------------------------------

const AGENT_ID = 'agent_model_reviewer';
const STALE_AGENT_ID = 'agent_model_stale';

function agentEntry(
  overrides: Partial<AgentModelRegistryEntry> = {},
): AgentModelRegistryEntry {
  return {
    id: AGENT_ID,
    name: 'Code Reviewer',
    baseModel: CLAUDE_GATEWAY,
    instructions: '',
    pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    // `available` is recomputed by initAgentModels from the base model, so the
    // value passed here is irrelevant — the base model drives availability.
    available: true,
    ...overrides,
  };
}

function renderAgentPicker(input: {
  currentModel?: string;
  lockedHarness?: ModelHarness;
  providerAvailability?: ProviderAvailability;
  billing?: 'subscription' | 'ai-credits';
  inheritedDefaultModel?: string;
  onModelChange?: (model: string) => void;
}): void {
  render(
    createElement(ModelPicker, {
      currentModel: input.currentModel ?? CLAUDE_GATEWAY,
      onModelChange: input.onModelChange ?? ((): void => {}),
      ...(input.inheritedDefaultModel
        ? { inheritedDefaultModel: input.inheritedDefaultModel }
        : {}),
      ...(input.lockedHarness ? { lockedHarness: input.lockedHarness } : {}),
      ...(input.providerAvailability
        ? { providerAvailability: input.providerAvailability }
        : {}),
      ...(input.billing
        ? {
            billing: {
              value: input.billing,
              onChange: (): void => {},
              provider: providerForModel(input.currentModel ?? CLAUDE_GATEWAY),
            },
          }
        : {}),
    }),
  );
  openPicker();
}

describe('ModelPicker Agents group', () => {
  afterEach(() => {
    // Clear the Agent overlay so it does not leak into other suites.
    initAgentModels([]);
    expect(AGENT_MODELS).toHaveLength(0);
  });

  it('renders an Agents group only when Agent models are registered', () => {
    // No agents yet → no agent option.
    renderPicker(undefined);
    expect(
      document.querySelector(`[data-testid="chat-model-option-${AGENT_ID}"]`),
    ).toBeNull();

    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';

    initAgentModels([agentEntry()]);
    expect(AGENT_MODELS).toContain(AGENT_ID);
    renderAgentPicker({});
    const agentOption = document.querySelector<HTMLElement>(
      `[data-testid="chat-model-option-${AGENT_ID}"]`,
    );
    expect(agentOption).not.toBeNull();
    // The Agent's friendly name is shown, not its raw id.
    expect(agentOption?.textContent).toContain('Code Reviewer');
    // The group header is present.
    expect(document.body.textContent).toContain('Agents');
  });

  it('keeps the Agents section above every model family on desktop', () => {
    initAgentModels([agentEntry()]);
    renderAgentPicker({});

    const menu = document.querySelector('[data-testid="chat-model-menu"]');
    const labels = Array.from(
      menu?.querySelectorAll('[data-testid^="chat-model-group-label-"]') ?? [],
    )
      .filter((label) => !label.closest('[hidden]'))
      .map((label) => label.textContent);
    expect(labels[0]).toBe('Agents');
  });

  it('shows a chat pinned to an inheriting Agent as that Agent', () => {
    initAgentModels([agentEntry({ baseModel: 'default' })]);
    renderAgentPicker({
      currentModel: `${AGENT_ID}@${CODEX_GATEWAY}`,
      lockedHarness: 'codex',
    });

    expect(option(AGENT_ID).getAttribute('aria-checked')).toBe('true');
    expect(isDisabled(AGENT_ID)).toBe(false);
    expect(
      document.querySelector('[data-testid="chat-model-picker"]')?.textContent,
    ).toContain('Code Reviewer');
  });

  it("gates an inheriting Agent on the chat's default model", () => {
    initAgentModels([agentEntry({ baseModel: 'default' })]);
    // The chat is on Claude, but its default is Codex: a Claude-locked chat
    // cannot run the Agent there.
    renderAgentPicker({
      lockedHarness: 'claude',
      inheritedDefaultModel: CODEX_GATEWAY,
    });
    expect(isDisabled(AGENT_ID)).toBe(true);

    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';

    renderAgentPicker({
      currentModel: CODEX_GATEWAY,
      lockedHarness: 'codex',
      inheritedDefaultModel: CODEX_GATEWAY,
    });
    expect(isDisabled(AGENT_ID)).toBe(false);
  });

  it('selects an inheriting Agent by its bare id so each chat pins its own default', () => {
    initAgentModels([agentEntry({ baseModel: 'default' })]);
    const onModelChange = jest.fn();
    renderAgentPicker({
      currentModel: CODEX_GATEWAY,
      lockedHarness: 'codex',
      inheritedDefaultModel: CODEX_GATEWAY,
      onModelChange,
    });
    clickOption(AGENT_ID);
    expect(onModelChange).toHaveBeenCalledWith(AGENT_ID);
  });

  it('opens recovery for an inheriting Agent with the route it would pin', async () => {
    initAgentModels([agentEntry({ baseModel: 'default' })]);
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadNativeAiCreditsAvailability: jest.fn().mockResolvedValue({
          personalEligible: false,
          orgSpendable: false,
          inOrg: false,
          orgCreditPoolCovered: false,
          inconclusive: false,
          pricingUrl: 'https://example.test/pricing',
        }),
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          account: { id: 'acct_1' },
          authMode: 'account',
          credentialSource: 'account',
          orgBillingStates: [],
        }),
      },
    });
    renderAgentPicker({
      currentModel: CLAUDE_NON_GATEWAY,
      providerAvailability: availability({}),
      inheritedDefaultModel: CLAUDE_GATEWAY,
    });

    await act(async () => {
      option(AGENT_ID).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The pinned default is credits-routable, so recovery must not call the
    // pick native-only.
    expect(recoveryModal()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-native-only"]'),
    ).toBeNull();
  });

  it('filters Agents by their base provider when a provider is locked', () => {
    initAgentModels([agentEntry()]); // base = claude
    // Locking to codex disables the claude-based Agent.
    renderAgentPicker({ lockedHarness: 'codex' });
    expect(isDisabled(AGENT_ID)).toBe(true);

    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';

    // Locking to the Agent's own base provider keeps it selectable.
    renderAgentPicker({ lockedHarness: 'claude' });
    expect(isDisabled(AGENT_ID)).toBe(false);
  });

  it('inherits AI Credits hidden-state from the base model routability', () => {
    // CAN-2349 case E, evaluated against the Agent's BASE model: a
    // non-gateway-routable base model cannot be billed to credits, so the Agent
    // row is hidden rather than greyed — and with only one Agent registered the
    // whole Agents group header goes with it.
    initAgentModels([agentEntry({ baseModel: CLAUDE_NON_GATEWAY })]);
    renderAgentPicker({ billing: 'ai-credits' });
    expect(isAbsent(AGENT_ID)).toBe(true);
    expect(
      document.querySelector('[data-testid="chat-model-group-label-agents"]'),
    ).toBeNull();

    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';

    // Under subscription billing the same Agent is selectable.
    renderAgentPicker({ billing: 'subscription' });
    expect(isDisabled(AGENT_ID)).toBe(false);
  });

  it('keeps a stale Agent visible but disabled', () => {
    initAgentModels([
      agentEntry({
        id: STALE_AGENT_ID,
        baseModel: 'model-that-does-not-exist',
      }),
    ]);
    // The stale Agent remains visible so saved configuration does not vanish,
    // but cannot be selected or executed.
    expect(AGENT_MODELS).toContain(STALE_AGENT_ID);
    renderAgentPicker({});
    expect(isDisabled(STALE_AGENT_ID)).toBe(true);
    expect(optionDetailText(STALE_AGENT_ID)).toContain(
      'This agent’s base model is unavailable.',
    );
  });
});

describe('ModelPicker composer focus return', () => {
  function renderWithRestore(onRestoreFocus: () => void): void {
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: (): void => {},
        onRestoreFocus,
      }),
    );
    openPicker();
  }

  /**
   * `FloatingMenu` synchronously focuses its trigger on every close path, so
   * the composer hand-off is deferred past that. Flush the microtask queue.
   */
  async function flushRestore(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('hands focus back to the caller after a model is chosen', async () => {
    const onRestoreFocus = jest.fn();
    renderWithRestore(onRestoreFocus);

    act(() => {
      option(CODEX_GATEWAY).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flushRestore();

    expect(onRestoreFocus).toHaveBeenCalledTimes(1);
  });

  it('hands focus back when a pending recovery SELF-cancels', async () => {
    // The guards unmount `ModelRecoveryModal` without the user cancelling it —
    // terminal mode here, and equally the case-E hide, org policy, or a stale
    // agent. Only `clearPendingRecovery` used to restore focus, so a recovery
    // that cancelled itself dropped focus to `<body>` and left a keyboard-only
    // user with no place in the composer to return to.
    const onRestoreFocus = jest.fn();
    const loadNativeAiCreditsAvailability = jest.fn().mockResolvedValue({
      personalEligible: false,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: true,
      pricingUrl: 'https://example.test/pricing',
    });
    const loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'account',
      credentialSource: 'account',
      orgBillingStates: [],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability, loadCanopyCloudAccount },
    });

    const pickerFor = (disabled: boolean): ReactNode =>
      createElement(ModelPicker, {
        currentModel: CLAUDE_NON_GATEWAY,
        onModelChange: (): void => {},
        onRestoreFocus,
        disabled,
        providerAvailability: availability({}),
      });

    root = createRoot(document.body);
    act(() => {
      root?.render(pickerFor(false));
    });
    openPicker();

    await act(async () => {
      option(CLAUDE_GATEWAY).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(recoveryModal()).not.toBeNull();
    onRestoreFocus.mockClear();

    // Terminal mode engages — Guard 1 tears the recovery down on its own.
    await act(async () => {
      root?.render(pickerFor(true));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(recoveryModal()).toBeNull();
    expect(onRestoreFocus).toHaveBeenCalled();
  });

  it('does NOT steal focus while disabled with no pending recovery', async () => {
    // Guard 1 tears a recovery down when the picker goes `disabled`, and that
    // teardown now moves focus. Firing it when there is nothing to tear down
    // turns a no-op into a focus STEAL — and `ChatInput` passes
    // `disabled={isTerminalMode}`, which is the bang-prefix composer mode, so
    // it would trigger the moment a draft starts with `!` and then again on
    // every render (the callback identity changes when the parent re-renders,
    // because callers pass an inline arrow).
    const onRestoreFocus = jest.fn();
    const pickerEl = (): ReactNode =>
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: (): void => {},
        // Fresh identity each render, exactly as the real callers do.
        onRestoreFocus: (): void => {
          onRestoreFocus();
        },
        disabled: true,
      });

    root = createRoot(document.body);
    await act(async () => {
      root?.render(pickerEl());
      await Promise.resolve();
    });
    expect(onRestoreFocus).not.toHaveBeenCalled();

    // Re-render with a new inline callback identity — still nothing to clear.
    await act(async () => {
      root?.render(pickerEl());
      await Promise.resolve();
    });
    await act(async () => {
      root?.render(pickerEl());
      await Promise.resolve();
    });
    expect(onRestoreFocus).not.toHaveBeenCalled();
  });

  it('does NOT steal focus from a child surface when a guard tears down', async () => {
    // The recovery modal HIDES (display:none) behind the shared cloud gate
    // rather than unmounting, so focus there belongs to `CloudSyncModal`. A
    // background registry broadcast (Guard 2) or org-policy refresh (Guard 3)
    // landing in that window must not pull the caret into the composer
    // underneath the open dialog — the same failure shape as the Guard 1
    // regression, one guard over.
    const onRestoreFocus = jest.fn();
    const loadNativeAiCreditsAvailability = jest.fn().mockResolvedValue({
      personalEligible: false,
      orgSpendable: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      inconclusive: true,
      pricingUrl: 'https://example.test/pricing',
    });
    const loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'account',
      credentialSource: 'account',
      orgBillingStates: [],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability, loadCanopyCloudAccount },
    });

    const pickerFor = (disabled: boolean): ReactNode =>
      createElement(ModelPicker, {
        currentModel: CLAUDE_NON_GATEWAY,
        onModelChange: (): void => {},
        onRestoreFocus,
        disabled,
        providerAvailability: availability({}),
      });

    root = createRoot(document.body);
    act(() => {
      root?.render(pickerFor(false));
    });
    openPicker();

    await act(async () => {
      option(CLAUDE_GATEWAY).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(recoveryModal()).not.toBeNull();
    onRestoreFocus.mockClear();

    // The shared cloud gate opens over everything.
    act(() => {
      useCloudConnectGateStore.setState({
        pending: { context: {}, proceed: (): void => {} },
      });
    });

    // A guard now tears the recovery down underneath it.
    await act(async () => {
      root?.render(pickerFor(true));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(recoveryModal()).toBeNull();
    expect(onRestoreFocus).not.toHaveBeenCalled();

    useCloudConnectGateStore.setState({ pending: null });
  });

  it('hands focus back to the caller when the menu is dismissed with Escape', async () => {
    const onRestoreFocus = jest.fn();
    renderWithRestore(onRestoreFocus);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flushRestore();

    expect(onRestoreFocus).toHaveBeenCalledTimes(1);
  });
});

/**
 * Tier 0: a row disabled purely because the chat is locked to another provider
 * used to render NO tooltip at all — `locked` was the only disable cause with
 * no arm in the reason chains, so `unavailableReason` stayed undefined and the
 * sr-only fallback was the literal word "unavailable".
 *
 * Tier 1: `lockedProviderBehavior="continue"` turns harness-mismatched
 * Claude/Codex rows back into ordinary selectable models, because the consumer
 * opens a "Continue on <Provider>" flow instead of calling setModel.
 */
describe('ModelPicker locked-provider behavior', () => {
  function renderLocked(input: {
    lockedProvider: AgentProviderType;
    lockedProviderBehavior?: 'disabled' | 'continue';
    lockedProviderReason?: string;
    onModelChange?: (model: string) => void;
    providerAvailability?: ProviderAvailability;
  }): void {
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: input.onModelChange ?? ((): void => {}),
        lockedProvider: input.lockedProvider,
        ...(input.lockedProviderBehavior
          ? { lockedProviderBehavior: input.lockedProviderBehavior }
          : {}),
        ...(input.lockedProviderReason
          ? { lockedProviderReason: input.lockedProviderReason }
          : {}),
        ...(input.providerAvailability
          ? { providerAvailability: input.providerAvailability }
          : {}),
      }),
    );
    openPicker();
  }

  function hoverReason(model: string): string | undefined {
    act(() => {
      option(model).dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    return (
      document.querySelector('[data-testid="chat-model-unavailable-tooltip"]')
        ?.textContent ?? undefined
    );
  }

  it('explains a locked native row instead of disabling it silently', () => {
    renderLocked({ lockedProvider: 'claude' });

    expect(isDisabled(CODEX_NON_GATEWAY)).toBe(true);
    // The sr-only reason node no longer falls back to the word "unavailable".
    expect(option(CODEX_NON_GATEWAY).textContent).toContain(
      'This chat is running on Claude. Start a new chat to use Codex models.',
    );
    expect(hoverReason(CODEX_NON_GATEWAY)).toBe(
      'This chat is running on Claude. Start a new chat to use Codex models.',
    );
  });

  it('orders the gateway-only reason chain org > locked > credits', () => {
    // No credits and no auth: before Tier 0 the locked row suppressed the
    // credits reason and supplied none of its own, so it had no tooltip.
    renderLocked({ lockedProvider: 'claude', providerAvailability: undefined });

    expect(isDisabled(CODEX_GATEWAY_ONLY)).toBe(true);
    expect(hoverReason(CODEX_GATEWAY_ONLY)).toBe(
      'This chat is running on Claude. Start a new chat to use Codex models.',
    );
  });

  it('prefers an explicit lockedProviderReason over the generic copy', () => {
    renderLocked({
      lockedProvider: 'claude',
      lockedProviderReason:
        'This chat is still working. Stop or finish the current turn, then switch.',
    });

    expect(isDisabled(CODEX_NON_GATEWAY)).toBe(true);
    expect(hoverReason(CODEX_NON_GATEWAY)).toBe(
      'This chat is still working. Stop or finish the current turn, then switch.',
    );
  });

  it('keeps a blocked-right-now reason off rows that can never be continued', () => {
    // `lockedProviderReason` describes a chat that could be continued but is
    // busy right now, so the consumer computes it for the one continuable
    // target. It must not leak onto an Ollama row, which would promise a
    // switch ("stop the current turn, then switch") that never becomes
    // available.
    renderLocked({
      lockedProvider: 'claude',
      lockedProviderReason:
        'This chat is still working. Stop or finish the current turn, then switch.',
    });

    expect(isDisabled(OLLAMA_MODEL)).toBe(true);
    expect(hoverReason(OLLAMA_MODEL)).toBe(
      'This chat is running on Claude. Start a new chat to use Ollama models.',
    );
  });

  it('enables cross-harness rows under "continue" with no added affordance', () => {
    const onModelChange = jest.fn();
    renderLocked({
      lockedProvider: 'claude',
      lockedProviderBehavior: 'continue',
      onModelChange,
    });

    const row = option(CODEX_NON_GATEWAY);
    expect(isDisabled(CODEX_NON_GATEWAY)).toBe(false);
    // Styled exactly like any other selectable row: no chip, badge, or reason.
    expect(row.getAttribute('aria-disabled')).toBeNull();
    expect(row.textContent).not.toContain('Start a new chat');
    expect(hoverReason(CODEX_NON_GATEWAY)).toBeUndefined();

    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onModelChange).toHaveBeenCalledWith(CODEX_NON_GATEWAY);
  });

  it('keeps Ollama rows locked under "continue" in both directions', () => {
    renderLocked({
      lockedProvider: 'claude',
      lockedProviderBehavior: 'continue',
    });
    expect(isDisabled(OLLAMA_MODEL)).toBe(true);
    expect(hoverReason(OLLAMA_MODEL)).toBe(
      'This chat is running on Claude. Start a new chat to use Ollama models.',
    );

    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';

    // An Ollama-locked chat cannot be continued onto Claude or Codex either.
    renderLocked({
      lockedProvider: 'ollama',
      lockedProviderBehavior: 'continue',
    });
    expect(isDisabled(CODEX_NON_GATEWAY)).toBe(true);
    expect(isDisabled(CLAUDE_NON_GATEWAY)).toBe(true);
  });

  it('offers a fresh chat for a never-continuable Ollama pair in chat surfaces', () => {
    const onModelChange = jest.fn();
    const onStartNewChat = jest.fn();
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange,
        lockedProvider: 'claude',
        lockedProviderBehavior: 'continue',
        providerAvailability: availability({}),
        onStartNewChat,
      }),
    );
    openPicker();

    expectIndistinguishable(OLLAMA_MODEL);
    clickOption(OLLAMA_MODEL);
    expect(recoveryModal()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-new-chat-body"]'),
    ).not.toBeNull();

    act(() => {
      document
        .querySelector('[data-testid="model-recovery-start-new-chat"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onStartNewChat).toHaveBeenCalledWith(OLLAMA_MODEL);
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('reveals the same hard-disabled reason persistently without selecting', () => {
    const onModelChange = jest.fn();
    renderLocked({
      lockedProvider: 'claude',
      lockedProviderReason:
        'This chat is still working. Stop or finish the current turn, then switch.',
      onModelChange,
    });

    const row = option(CODEX_NON_GATEWAY);
    const reason = row.querySelector<HTMLElement>(
      '[data-testid="chat-model-option-locked-codex"]',
    );
    expect(reason?.className).toBe('sr-only');
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });

    expect(reason?.className).not.toBe('sr-only');
    // The announcement comes from the sibling live region gaining content, not
    // from this node changing class (a class change mutates no content, so
    // `aria-live` on it would never fire).
    const live = row.nextElementSibling;
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent).toBe(reason?.textContent);
    expect(row.getAttribute('aria-checked')).toBe('false');
    expect(onModelChange).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="chat-model-unavailable-tooltip"]'),
    ).toBeNull();
  });

  it('adds no locked affordance when no provider is locked', () => {
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: (): void => {},
        lockedProviderBehavior: 'continue',
      }),
    );
    openPicker();

    expect(isDisabled(CODEX_NON_GATEWAY)).toBe(false);
    expect(hoverReason(CODEX_NON_GATEWAY)).toBeUndefined();
  });

  it('names the base provider in a locked Agent row reason', () => {
    initAgentModels([agentEntry()]); // base = claude
    renderLocked({ lockedProvider: 'codex' });

    expect(isDisabled(AGENT_ID)).toBe(true);
    expect(hoverReason(AGENT_ID)).toBe(
      'This chat is running on Codex. Start a new chat to use Claude models.',
    );

    initAgentModels([]);
  });

  it('enables a cross-harness Agent under "continue" but never a stale one', () => {
    initAgentModels([agentEntry()]); // base = claude
    renderLocked({
      lockedProvider: 'codex',
      lockedProviderBehavior: 'continue',
    });
    expect(isDisabled(AGENT_ID)).toBe(false);

    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';

    // A stale Agent outranks the continue affordance.
    initAgentModels([agentEntry({ baseModel: 'model-that-does-not-exist' })]);
    renderLocked({
      lockedProvider: 'codex',
      lockedProviderBehavior: 'continue',
    });
    expect(isDisabled(AGENT_ID)).toBe(true);
    expect(hoverReason(AGENT_ID)).toBe(
      'This agent’s base model is unavailable.',
    );

    initAgentModels([]);
  });
});

describe('ModelPicker shared hard-disabled reveal', () => {
  const cases: readonly [string, () => void, string][] = [
    [
      'config-surface gateway-only row',
      (): void => renderPicker(undefined),
      CODEX_GATEWAY_ONLY,
    ],
    [
      'organization-policy row',
      (): void => {
        useModelCatalogStore.setState({
          policy: new Set<string>([CLAUDE_NON_GATEWAY]),
        });
        renderPicker(
          availability({
            claude: {
              selectable: true,
              nativeAuth: true,
              creditsEligible: false,
              loading: false,
            },
          }),
        );
      },
      CLAUDE_NON_GATEWAY,
    ],
    [
      'stale Agent row',
      (): void => {
        initAgentModels([
          agentEntry({
            id: STALE_AGENT_ID,
            baseModel: 'model-that-does-not-exist',
          }),
        ]);
        renderAgentPicker({});
      },
      STALE_AGENT_ID,
    ],
  ];

  it.each(cases)(
    '%s reveals its reason without selecting',
    (_name, setup, model) => {
      setup();
      const row = option(model);
      // Two nodes: the always-present `aria-describedby` target that flips
      // from `sr-only` to visible, and the announce-only live region that is
      // EMPTY until the reveal. `aria-live` announces on content mutation, so
      // a class flip alone announces nothing — the live region has to gain
      // text for a screen reader to say anything at all.
      const reason = row.querySelector<HTMLElement>(
        '[data-testid^="chat-model-option-locked-"]',
      );
      // The live region is the button's immediate SIBLING: inside the button
      // its text would join the row's accessible name and the reason would be
      // announced twice. (Scoped to this row — every locked row renders one.)
      const live = row.nextElementSibling;
      expect(row.querySelector('[aria-live="polite"]')).toBeNull();
      expect(live?.getAttribute('aria-live')).toBe('polite');
      const checkedBefore = row.getAttribute('aria-checked');
      expect(row.getAttribute('aria-disabled')).toBe('true');
      expect(reason?.className).toBe('sr-only');
      expect(reason?.textContent).toBeTruthy();
      expect(live?.textContent).toBe('');

      act(() => {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(reason?.className).not.toBe('sr-only');
      expect(live?.textContent).toBe(reason?.textContent);
      expect(row.getAttribute('aria-checked')).toBe(checkedBefore);
    },
  );
});

describe('ModelPicker org-gateway grouping', () => {
  const ORG_MODEL = 'acme-qwen3-coder';
  const ORG_ID = 'org-acme';

  function groupHeaderTextFor(model: string): string {
    // Read the heading through the section's own `role="group"` rather than a
    // fixed parent depth, so the assertion survives a change to the list's
    // wrapper nesting.
    const group = option(model).closest('[role="group"]');
    return (
      group?.querySelector('[data-testid^="chat-model-group-label-"]')
        ?.textContent ?? ''
    );
  }

  const orgEntry: AiGatewayModelEntry = {
    id: ORG_MODEL,
    label: 'Acme Qwen3 Coder',
    recommendedHarness: 'codex',
    contextWindow: 256_000,
    supportsPromptCaching: true,
    supportedThinkingLevels: [],
    toolSchemaProfile: 'standard',
    family: 'custom',
    familyLabel: 'Acme',
    vendor: `org-gateway:${ORG_ID}`,
  };

  const orgRoute: GatewayRouteEntry = {
    ...gatewayRoute(ORG_MODEL, 'codex', true),
    origin: 'org-gateway',
    baseUrl: 'https://gw.acme.test',
    organizationId: ORG_ID,
    promptCachePassthrough: true,
  };

  beforeEach(() => {
    initAiGatewayModels(
      [...API_GATEWAY_ENTRIES, orgEntry],
      [...GATEWAY_ROUTES, orgRoute],
    );
    // `vendorLabels` is derived from the STORE snapshot, not the module
    // registry: the heading text is the org's name and only the snapshot
    // carries it.
    act(() => {
      useModelCatalogStore.setState({
        snapshot: {
          claude: [],
          codex: [],
          ollama: [],
          aliases: {},
          aiGatewayModels: [...API_GATEWAY_ENTRIES, orgEntry],
          gatewayRoutes: [...GATEWAY_ROUTES, orgRoute],
        },
      });
    });
  });

  afterEach(() => {
    act(() => {
      useModelCatalogStore.setState({ snapshot: null });
    });
    registerModelRegistries();
  });

  it('files an org model under its organization, not under hosted AI Credits', () => {
    renderPicker(undefined);

    // The org's own row reads under the org's name...
    expect(groupHeaderTextFor(ORG_MODEL)).toContain('Acme');
    // ...and never shares a section with a hosted gateway-only row, which is
    // billed by us and not by the org's provider contract.
    expect(groupHeaderTextFor(ORG_MODEL)).not.toBe(
      groupHeaderTextFor(GATEWAY_API_CODEX),
    );
    expect(
      document.querySelector(
        `[data-testid="chat-model-option-extra-charge-${ORG_MODEL}"]`,
      ),
    ).toBeNull();
  });

  it('keeps an org model that collides with one of ours as its own row', () => {
    renderPicker(undefined);

    // Namespaced selection ids mean the two never merge, and the differing
    // section headings are what tell a user which is which.
    expect(option(ORG_MODEL)).not.toBeNull();
    expect(option(CODEX_GATEWAY_ONLY)).not.toBeNull();
    expect(groupHeaderTextFor(ORG_MODEL)).not.toBe(
      groupHeaderTextFor(CODEX_GATEWAY_ONLY),
    );
  });

  it('disambiguates an organization model in the collapsed trigger', () => {
    renderPicker(undefined, { currentModel: ORG_MODEL });
    expect(
      document.querySelector('[data-testid="chat-model-picker"]')?.textContent,
    ).toContain('Acme · Acme Qwen3 Coder');
  });
});

/**
 * CAN-3026 — the guest model gate, end to end through the picker.
 *
 * The scope assertions matter as much as the interception one: a guest running
 * their OWN Claude subscription or local Ollama costs Canopy nothing, and
 * `deepseek-v4-pro` is the lane default already shipped to installed clients.
 */
describe('ModelPicker — guest model gate (CAN-3026)', () => {
  /**
   * A FUNDED guest. Every consented guest receives the daily AI-credit drip
   * (`DEFAULT_DAILY_DRIP_CAP_CREDITS`), so this — not an empty balance — is the
   * state the gate must hold against.
   */
  function stubFundedGuestAccount(): void {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadNativeAiCreditsAvailability: jest.fn().mockResolvedValue({
          personalEligible: true,
          orgSpendable: false,
          inOrg: false,
          orgCreditPoolCovered: false,
          inconclusive: false,
          pricingUrl: 'https://example.test/pricing',
        }),
        // No connected account => `read.guest` is true in the modal.
        loadCanopyCloudAccount: jest.fn().mockResolvedValue(null),
      },
    });
  }

  async function clickAndSettle(model: string): Promise<void> {
    await act(async () => {
      option(model).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function needsAccountBody(): Element | null {
    return document.querySelector(
      '[data-testid="model-recovery-needs-account"]',
    );
  }

  it('intercepts a guest selecting a gateway-only model and never commits', async () => {
    mockIsGuest = true;
    stubFundedGuestAccount();
    const onModelChange = jest.fn();

    renderPicker(
      availability({
        claude: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: true,
          loading: false,
        },
      }),
      { onModelChange, currentModel: CLAUDE_NON_GATEWAY },
    );

    // CAN-4028 changed this on purpose. A library lock is a standing property
    // of the account rather than something fixed in passing, so the row now
    // says so up front with the shared hint. It stays ENABLED and reachable:
    // activating it is what starts the recovery.
    expect(isDisabled(CLAUDE_GATEWAY_ONLY)).toBe(false);
    // No reported access falls back to plain sign-in.
    expectLibraryLocked(CLAUDE_GATEWAY_ONLY, 'Unlock with sign-in', 'Sign in');

    await clickAndSettle(CLAUDE_GATEWAY_ONLY);

    expect(needsAccountBody()).not.toBeNull();
    // Funded, and STILL not committed: the modal's coverage auto-commit must
    // not clear an account gate, because credits were never the missing thing.
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it.each([
    ['needs_sign_in', 'Unlock with sign-in', 'Sign in'],
    [
      'needs_sign_in_then_purchase',
      'Unlock with sign-in and AI Credit purchase',
      // CAN-5213: the visible label names both steps.
      'Sign in and buy',
    ],
  ] as const)('labels %s with the full hint', (access, hint, label) => {
    mockIsGuest = true;
    mockLibraryAccess = access;
    stubFundedGuestAccount();

    renderPicker(
      availability({
        claude: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: true,
          loading: false,
        },
      }),
      { onModelChange: jest.fn(), currentModel: CLAUDE_NON_GATEWAY },
    );

    expectLibraryLocked(CLAUDE_GATEWAY_ONLY, hint, label);
  });

  it('intercepts a guest selecting a credit-routed native model', async () => {
    // Gateway-only rows alone would be insufficient: the expensive models are
    // native-registry rows that merely ROUTE through credits for a guest with
    // no provider login.
    mockIsGuest = true;
    stubFundedGuestAccount();
    const onModelChange = jest.fn();

    renderPicker(
      availability({
        claude: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: true,
          loading: false,
        },
      }),
      { onModelChange, currentModel: CLAUDE_NON_GATEWAY },
    );

    await clickAndSettle(CLAUDE_GATEWAY);

    expect(needsAccountBody()).not.toBeNull();
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('does not relabel an explicit subscription attempt as AI Credits after negative auth', async () => {
    mockIsGuest = true;
    stubFundedGuestAccount();
    const onModelChange = jest.fn();

    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_NON_GATEWAY,
        onModelChange,
        providerAvailability: availability({
          claude: {
            selectable: true,
            nativeAuth: false,
            creditsEligible: true,
            loading: false,
          },
        }),
        billing: {
          value: 'subscription',
          onChange: jest.fn(),
          provider: 'claude',
          allowUnverifiedSubscription: true,
        },
      }),
    );
    openPicker();

    expect(option(CLAUDE_GATEWAY).textContent).not.toContain('AI Credits');
    await clickAndSettle(CLAUDE_GATEWAY);
    expect(recoveryModal()).toBeNull();
    expect(onModelChange).toHaveBeenCalledWith(CLAUDE_GATEWAY);
  });

  it('does not admit an unrelated Codex hosted row through the Claude subscription override', async () => {
    mockIsGuest = true;
    stubFundedGuestAccount();
    const onModelChange = jest.fn();
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange,
        providerAvailability: availability({
          codex: {
            selectable: true,
            nativeAuth: false,
            creditsEligible: true,
            loading: false,
          },
        }),
        billing: {
          value: 'subscription',
          provider: 'claude',
          allowUnverifiedSubscription: true,
          onChange: jest.fn(),
        },
      }),
    );
    openPicker();
    await clickAndSettle(CODEX_GATEWAY);
    expect(needsAccountBody()).not.toBeNull();
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('lets a guest commit the shipped AI-Credits lane default with no modal', async () => {
    // DECISION-0 REGRESSION TEST. `deepseek-v4-pro` is the lane default in
    // already-shipped desktop builds; prompting for it would hit every
    // installed guest client that never touched the picker.
    mockIsGuest = true;
    stubFundedGuestAccount();
    const onModelChange = jest.fn();

    renderPicker(
      availability({
        codex: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: true,
          loading: false,
        },
      }),
      { onModelChange, currentModel: CLAUDE_NON_GATEWAY },
    );

    await clickAndSettle(CODEX_GATEWAY_ONLY);

    expect(recoveryModal()).toBeNull();
    expect(onModelChange).toHaveBeenCalledWith(CODEX_GATEWAY_ONLY);
  });

  it("leaves a guest's own natively-authed subscription models alone", async () => {
    // ANTI-REGRESSION. Canopy pays nothing here, and forcing an allowlisted
    // model would push this guest OFF a free subscription ONTO the gateway.
    mockIsGuest = true;
    stubFundedGuestAccount();
    const onModelChange = jest.fn();

    renderPicker(
      availability({
        claude: {
          selectable: true,
          nativeAuth: true,
          creditsEligible: true,
          loading: false,
        },
      }),
      { onModelChange, currentModel: CODEX_NON_GATEWAY },
    );

    await clickAndSettle(CLAUDE_NON_GATEWAY);

    expect(recoveryModal()).toBeNull();
    expect(onModelChange).toHaveBeenCalledWith(CLAUDE_NON_GATEWAY);
  });

  it('leaves a guest local Ollama models', async () => {
    mockIsGuest = true;
    stubFundedGuestAccount();
    const onModelChange = jest.fn();

    renderPicker(availability({}), {
      onModelChange,
      currentModel: CLAUDE_NON_GATEWAY,
    });

    await clickAndSettle(OLLAMA_MODEL);

    expect(recoveryModal()).toBeNull();
    expect(onModelChange).toHaveBeenCalledWith(OLLAMA_MODEL);
  });

  it('routes the guest sign-in through the shared cloud gate, not a commit', async () => {
    mockIsGuest = true;
    stubFundedGuestAccount();
    const onModelChange = jest.fn();
    let connectContext: CloudConnectGateContext | null = null;
    const requestConnect = jest.fn((context: CloudConnectGateContext): void => {
      connectContext = context;
    });
    const realRequestConnect =
      useCloudConnectGateStore.getState().requestConnect;
    act(() => {
      useCloudConnectGateStore.setState({ requestConnect });
    });

    renderPicker(
      availability({
        claude: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: true,
          loading: false,
        },
      }),
      { onModelChange, currentModel: CLAUDE_NON_GATEWAY },
    );

    await clickAndSettle(CLAUDE_GATEWAY_ONLY);
    expect(needsAccountBody()).not.toBeNull();

    act(() => {
      document
        .querySelector('[data-testid="model-recovery-account-sign-in"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(requestConnect).toHaveBeenCalledTimes(1);
    expect(connectContext).toMatchObject({ guestBenefits: true });
    // The commit belongs to the post-sign-in coverage re-read, which is the
    // only thing that can prove the new account can run this model.
    expect(onModelChange).not.toHaveBeenCalled();

    // Restore the singleton so later specs are not left with a stub.
    act(() => {
      useCloudConnectGateStore.setState({ requestConnect: realRequestConnect });
    });
  });

  it('leaves a signed-in user on the ordinary credits path', async () => {
    // `isGuest` false => zero diff. The gateway-only row with no credits still
    // resolves to `needs-credits`, not `needs-account`.
    mockIsGuest = false;
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadNativeAiCreditsAvailability: jest.fn().mockResolvedValue({
          personalEligible: false,
          orgSpendable: false,
          inOrg: false,
          orgCreditPoolCovered: false,
          inconclusive: false,
          pricingUrl: 'https://example.test/pricing',
        }),
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          account: { id: 'acct_1' },
          authMode: 'account',
          credentialSource: 'account',
          orgBillingStates: [],
        }),
      },
    });
    const onModelChange = jest.fn();

    renderPicker(availability({}), {
      onModelChange,
      currentModel: CLAUDE_NON_GATEWAY,
    });

    await clickAndSettle(CLAUDE_GATEWAY_ONLY);

    expect(needsAccountBody()).toBeNull();
    expect(recoveryModal()).not.toBeNull();
    expect(onModelChange).not.toHaveBeenCalled();
  });
});

/**
 * CAN-5213 — availability cues for a library-locked viewer. A drip-off guest
 * with no provider login sees which rows need free daily credits; once credits
 * settle the same rows say Available. Neither cue changes selection, recovery,
 * or the order of the list.
 */
describe('ModelPicker — guest availability cues (CAN-5213)', () => {
  function stubGuestCredits(funded: boolean): void {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadNativeAiCreditsAvailability: jest.fn().mockResolvedValue({
          personalEligible: funded,
          orgSpendable: false,
          inOrg: false,
          orgCreditPoolCovered: false,
          inconclusive: false,
          dailyDripEnabled: funded,
          pricingUrl: 'https://example.test/pricing',
        }),
        loadCanopyCloudAccount: jest.fn().mockResolvedValue(null),
      },
    });
  }

  function guestCodex(funded: boolean): ProviderAvailability {
    return availability({
      codex: {
        selectable: funded,
        nativeAuth: false,
        creditsEligible: funded,
        loading: false,
        creditsLoading: false,
        dailyCreditsEnabled: funded,
      },
    });
  }

  function rowOrder(): (string | null)[] {
    return Array.from(document.querySelectorAll('[data-model-id]')).map((row) =>
      row.getAttribute('data-model-id'),
    );
  }

  it('asks a drip-off guest for free daily credits and recovers without selecting', async () => {
    mockIsGuest = true;
    stubGuestCredits(false);
    const onModelChange = jest.fn();
    renderPicker(guestCodex(false), { onModelChange });

    const row = option(CODEX_GATEWAY_ONLY);
    expect(row.getAttribute('data-locked')).toBe('true');
    expect(row.hasAttribute('data-available')).toBe(false);
    expect(
      row.querySelector('[data-testid*="-option-lock-label"]')?.textContent,
    ).toBe('Needs free daily credits');
    expect(row.textContent).toContain(
      'Turn on free daily credits to use this model.',
    );

    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('names the Codex sign-in on a native-only row whatever the credits', async () => {
    for (const funded of [false, true]) {
      mockIsGuest = true;
      stubGuestCredits(funded);
      const onModelChange = jest.fn();
      renderPicker(guestCodex(funded), { onModelChange });

      // Credits can never run this model, so a sign-in is the only way in.
      const row = option(CODEX_NON_GATEWAY);
      expect(row.getAttribute('data-locked')).toBe('true');
      expect(row.hasAttribute('data-available')).toBe(false);
      expect(
        row.querySelector('[data-testid*="-option-lock-label"]')?.textContent,
      ).toBe('Needs Codex sign-in');
      expect(row.textContent).toContain('Sign in to Codex to use this model.');

      await act(async () => {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onModelChange).not.toHaveBeenCalled();
      act(() => root?.unmount());
      root = null;
      document.body.innerHTML = '';
    }
  });

  it('keeps the drip-off row where the funded list puts it', () => {
    mockIsGuest = true;
    stubGuestCredits(true);
    renderPicker(guestCodex(true));
    const funded = rowOrder();
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';

    stubGuestCredits(false);
    renderPicker(guestCodex(false));
    expect(rowOrder()).toEqual(funded);
  });

  it('marks a funded guest’s row Available and selects it normally', () => {
    mockIsGuest = true;
    stubGuestCredits(true);
    const onModelChange = jest.fn<void, [string]>();
    renderPicker(guestCodex(true), { onModelChange });

    const row = option(CODEX_GATEWAY_ONLY);
    expect(row.getAttribute('data-available')).toBe('true');
    expect(row.hasAttribute('data-locked')).toBe(false);
    expect(row.getAttribute('role')).toBe('menuitemradio');

    clickOption(CODEX_GATEWAY_ONLY);
    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onModelChange.mock.calls[0]?.[0]).toBe(CODEX_GATEWAY_ONLY);
  });

  it('adds no cue for an unlocked account', () => {
    mockLibraryAccess = 'unlocked';
    stubGuestCredits(true);
    renderPicker(guestCodex(true));
    const row = option(CODEX_GATEWAY_ONLY);
    expect(row.hasAttribute('data-available')).toBe(false);
    expect(row.hasAttribute('data-locked')).toBe(false);
  });

  it('adds no cue on a config surface without availability', () => {
    mockIsGuest = true;
    stubGuestCredits(false);
    renderPicker(undefined);
    expect(document.querySelector('[data-available]')).toBeNull();
    expect(window.api.loadNativeAiCreditsAvailability).not.toHaveBeenCalled();
  });
});

/**
 * CAN-4028 — a SIGNED-IN account that has not made a card purchase. The same
 * allowlist applies, but the remedy is a purchase, and specifically not "any
 * spendable credit": every case here runs FUNDED, because the daily free
 * credits are spendable and must not clear the lock.
 */
describe('ModelPicker — purchase unlock (CAN-4028)', () => {
  const ACCOUNT_KEY = 'account:acct_1';
  let paymentHandoff: jest.Mock;
  const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

  function stubFundedNonPayer(
    access: ModelLibraryAccess = 'needs_purchase',
  ): void {
    paymentHandoff = jest
      .fn()
      .mockResolvedValue({ ok: true, requestId: REQUEST_ID });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadNativeAiCreditsAvailability: jest.fn().mockResolvedValue({
          personalEligible: true,
          orgSpendable: false,
          inOrg: false,
          orgCreditPoolCovered: false,
          inconclusive: false,
          pricingUrl: 'https://example.test/pricing',
        }),
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          account: { id: 'acct_1' },
          authMode: 'oauth',
          credentialSource: 'oauth',
          orgBillingStates: [],
        }),
        loadCanopyCloudEntitlements: jest.fn().mockResolvedValue({
          resolved: true,
          modelLibrary: { status: 'reported', access },
          modelLibraryAccountKey: ACCOUNT_KEY,
          workModelLibrary: { status: 'reported', access },
          modelLibraryOwnerKey: 'personal',
        }),
        accountOrganizationSettings: { paymentHandoff },
      },
    });
  }

  const fundedNoProviderLogin = (): ProviderAvailability =>
    availability({
      claude: {
        selectable: true,
        nativeAuth: false,
        creditsEligible: true,
        loading: false,
      },
    });

  /** The recovery read now awaits three reads in turn; let them all land. */
  async function settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 40; i += 1) {
        await Promise.resolve();
      }
    });
  }

  async function clickAndSettle(testId: string): Promise<void> {
    act(() => {
      document
        .querySelector(`[data-testid="${testId}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
  }

  /** Dismiss the recovery modal through its X, its only dismiss. */
  async function closeRecovery(): Promise<void> {
    act(() => {
      document
        .querySelector(
          '[data-testid="model-recovery-modal"] button[aria-label="Close"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
  }

  function bodyText(testId: string): string | null {
    return (
      document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
    );
  }

  it('locks a non-allowlisted Canopy-paid row and opens purchase recovery, never committing', async () => {
    mockLibraryAccess = 'needs_purchase';
    stubFundedNonPayer();
    const onModelChange = jest.fn();
    renderPicker(fundedNoProviderLogin(), {
      onModelChange,
      currentModel: CLAUDE_NON_GATEWAY,
    });

    expectLibraryLocked(CLAUDE_GATEWAY_ONLY, 'Unlock with AI Credit purchase');

    await clickAndSettle(`chat-model-option-${CLAUDE_GATEWAY_ONLY}`);

    // Named for the clicked row, not the composer's current model.
    expect(recoveryModal()?.querySelector('h2')?.textContent).toBe(
      'Unlock Claude Gateway Only',
    );
    expect(bodyText('model-recovery-unlock')).toBe(
      `Free daily credits don't unlock advanced models. Purchase some AI Credits (minimum $${BILLING_TOP_UP_MIN_USD}) to unlock Sonnet, Opus, Fable and more. We'll switch to your selected model once the purchase is complete.`,
    );
    expect(bodyText('model-recovery-unlock-purchase')).toBe('Get AI Credits');
    // The dialog's X is the only dismiss.
    expect(bodyText('model-recovery-cancel')).toBeNull();
    // Funded, and still not committed: spendable daily credits are not the
    // purchase, so the coverage auto-commit must not fire.
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('opens browser checkout with the unlock intent and waits there', async () => {
    mockLibraryAccess = 'needs_purchase';
    stubFundedNonPayer();
    const onModelChange = jest.fn();
    renderPicker(fundedNoProviderLogin(), {
      onModelChange,
      currentModel: CLAUDE_NON_GATEWAY,
    });
    await clickAndSettle(`chat-model-option-${CLAUDE_GATEWAY_ONLY}`);
    await clickAndSettle('model-recovery-unlock-purchase');

    expect(paymentHandoff).toHaveBeenCalledTimes(1);
    expect(paymentHandoff).toHaveBeenCalledWith({
      accountId: 'acct_1',
      owner: { kind: 'personal' },
      intent: {
        kind: 'top-up',
        reason: 'unlock_models',
        source: 'desktop',
        modelId: CLAUDE_GATEWAY_ONLY,
      },
    });

    expect(bodyText('model-recovery-unlock-waiting')).toContain(
      "Finish checkout in your browser. Closing this dialog won't cancel your purchase.",
    );
    // The attempt is remembered for THIS account and model, under the same
    // request id the browser was given.
    expect(useModelUnlockIntentStore.getState()).toMatchObject({
      phase: 'waiting',
      intent: {
        requestId: REQUEST_ID,
        accountId: ACCOUNT_KEY,
        owner: 'personal',
        modelId: CLAUDE_GATEWAY_ONLY,
      },
    });
    // Opening checkout selects nothing.
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('leaves allowlisted and own-subscription rows unlocked', () => {
    mockLibraryAccess = 'needs_purchase';
    stubFundedNonPayer();
    renderPicker(
      availability({
        claude: {
          selectable: true,
          nativeAuth: true,
          creditsEligible: true,
          loading: false,
        },
        codex: {
          selectable: true,
          nativeAuth: false,
          creditsEligible: true,
          loading: false,
        },
      }),
      { currentModel: CLAUDE_NON_GATEWAY },
    );
    // Run on the user's own Claude subscription: not Canopy-paid.
    expect(option(CLAUDE_GATEWAY).getAttribute('data-locked')).toBeNull();
    // The shipped AI Credits lane default, which is on the allowlist.
    expect(option(CODEX_GATEWAY_ONLY).getAttribute('data-locked')).toBeNull();
  });

  it('keeps an organization policy block as the row’s reason', () => {
    mockLibraryAccess = 'needs_purchase';
    stubFundedNonPayer();
    useModelCatalogStore.setState({
      // Policy is keyed by the gateway id for a routed model.
      policy: new Set<string>([`vendor/${CLAUDE_GATEWAY_ONLY}`]),
    });
    renderPicker(fundedNoProviderLogin(), {
      currentModel: CLAUDE_NON_GATEWAY,
    });
    // Disabled wins over locked: a purchase cannot lift a policy block.
    expect(isDisabled(CLAUDE_GATEWAY_ONLY)).toBe(true);
    expect(option(CLAUDE_GATEWAY_ONLY).getAttribute('data-locked')).toBeNull();
  });

  it('draws no lock on a configuration surface', () => {
    mockLibraryAccess = 'needs_purchase';
    stubFundedNonPayer();
    // No `providerAvailability`: a config surface, which writes a value
    // rather than a chat turn.
    renderPicker(undefined, { currentModel: CLAUDE_NON_GATEWAY });
    expect(option(CLAUDE_GATEWAY_ONLY).getAttribute('data-locked')).toBeNull();
  });

  it('unlocks a Default-model Agent on AI Credits with the route it would pin', async () => {
    mockLibraryAccess = 'needs_purchase';
    stubFundedNonPayer();
    initAgentModels([agentEntry({ baseModel: 'default' })]);
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: (): void => {},
        inheritedDefaultModel: CLAUDE_GATEWAY,
        browserLayout: 'harnesses',
        providerAvailability: availability({
          claude: {
            selectable: true,
            nativeAuth: true,
            creditsEligible: true,
            loading: false,
          },
        }),
        billing: {
          value: 'ai-credits',
          onChange: (): void => {},
          provider: 'claude',
        },
      }),
    );
    openPicker();

    const locked = Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-testid="chat-model-option-${AGENT_ID}"][data-locked="true"]`,
      ),
    );
    expect(locked).not.toHaveLength(0);
    act(() => {
      locked[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    await clickAndSettle('model-recovery-unlock-purchase');

    // The confirmed unlock applies the route, as a click on the row would.
    expect(paymentHandoff).toHaveBeenCalledTimes(1);
    expect(useModelUnlockIntentStore.getState().intent?.modelId).toBe(
      `${AGENT_ID}@${CLAUDE_GATEWAY}`,
    );
  });

  it('keeps the purchase action and never waits in the browser after strict handoff failure', async () => {
    mockLibraryAccess = 'needs_purchase';
    stubFundedNonPayer();
    paymentHandoff.mockResolvedValue({ ok: false, reason: 'browser_failed' });
    const onModelChange = jest.fn();
    renderPicker(fundedNoProviderLogin(), {
      onModelChange,
      currentModel: CLAUDE_NON_GATEWAY,
    });
    await clickAndSettle(`chat-model-option-${CLAUDE_GATEWAY_ONLY}`);
    await clickAndSettle('model-recovery-unlock-purchase');
    expect(bodyText('model-recovery-unlock-failed')).toContain(
      'couldn’t open your browser',
    );
    expect(bodyText('model-recovery-unlock-waiting')).toBeNull();
    expect(bodyText('model-recovery-unlock-purchase')).toBe('Get AI Credits');
    expect(useModelUnlockIntentStore.getState().intent).toBeNull();
    expect(onModelChange).not.toHaveBeenCalled();
  });

  describe('after Close (CAN-5030)', () => {
    /** Click a row, opening the picker first if closing the modal shut it. */
    async function clickRow(model: string): Promise<void> {
      if (
        document.querySelector(`[data-testid="chat-model-option-${model}"]`) ===
        null
      ) {
        openPicker();
      }
      await clickAndSettle(`chat-model-option-${model}`);
    }

    async function purchaseThenClose(): Promise<void> {
      await clickRow(CLAUDE_GATEWAY_ONLY);
      await clickAndSettle('model-recovery-unlock-purchase');
      expect(paymentHandoff).toHaveBeenCalledTimes(1);
      await closeRecovery();
      expect(recoveryModal()).toBeNull();
    }

    function otherLockedRow(): string {
      if (
        document.querySelector('[data-testid^="chat-model-option-"]') === null
      ) {
        openPicker();
      }
      const ids = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid^="chat-model-option-"][data-locked="true"]',
        ),
      )
        // A library lock, not an availability cue such as a provider sign-in.
        .filter(
          (row) =>
            !/^Needs /.test(
              row.querySelector('[data-testid*="-option-lock-label"]')
                ?.textContent ?? '',
            ),
        )
        .map((row) =>
          (row.dataset.testid ?? '').slice('chat-model-option-'.length),
        )
        .filter((id) => id !== CLAUDE_GATEWAY_ONLY);
      const other = ids[0];
      if (other === undefined) throw new Error('no second locked row');
      return other;
    }

    it('resumes the waiting purchase when the same locked row is clicked again', async () => {
      mockLibraryAccess = 'needs_purchase';
      stubFundedNonPayer();
      renderPicker(fundedNoProviderLogin(), {
        currentModel: CLAUDE_NON_GATEWAY,
      });
      await purchaseThenClose();

      await clickRow(CLAUDE_GATEWAY_ONLY);

      expect(bodyText('model-recovery-unlock-waiting')).toContain(
        "Closing this dialog won't cancel your purchase.",
      );
      expect(bodyText('model-recovery-unlock-check-now')).toBe('Check again');
      expect(bodyText('model-recovery-unlock-purchase')).toBeNull();
      expect(paymentHandoff).toHaveBeenCalledTimes(1);
      expect(useModelUnlockIntentStore.getState()).toMatchObject({
        phase: 'waiting',
        intent: { requestId: REQUEST_ID, modelId: CLAUDE_GATEWAY_ONLY },
      });
    });

    it('resumes the original purchase and model from a different locked row', async () => {
      mockLibraryAccess = 'needs_purchase';
      stubFundedNonPayer();
      renderPicker(fundedNoProviderLogin(), {
        currentModel: CLAUDE_NON_GATEWAY,
      });
      await purchaseThenClose();

      const other = otherLockedRow();
      await clickRow(other);

      const copy = bodyText('model-recovery-unlock-waiting') ?? '';
      expect(copy).toContain("Closing this dialog won't cancel your purchase.");
      expect(copy).not.toContain(getModelDisplayName(other));
      expect(bodyText('model-recovery-unlock-purchase')).toBeNull();
      expect(paymentHandoff).toHaveBeenCalledTimes(1);
      expect(useModelUnlockIntentStore.getState().intent).toMatchObject({
        requestId: REQUEST_ID,
        modelId: CLAUDE_GATEWAY_ONLY,
      });
    });

    it('offers an explicit new purchase after a timeout, and a fresh one once dismissed', async () => {
      mockLibraryAccess = 'needs_purchase';
      stubFundedNonPayer();
      renderPicker(fundedNoProviderLogin(), {
        currentModel: CLAUDE_NON_GATEWAY,
      });
      await purchaseThenClose();
      act(() => {
        useModelUnlockIntentStore.setState({ phase: 'timed-out' });
      });

      await clickRow(CLAUDE_GATEWAY_ONLY);
      expect(bodyText('model-recovery-unlock-timed-out')).toContain(
        "Starting a new purchase won't cancel the previous one.",
      );
      expect(bodyText('model-recovery-unlock-new-purchase')).toBe(
        'Start a new purchase',
      );
      expect(bodyText('model-recovery-unlock-purchase')).toBeNull();
      await closeRecovery();

      // The composer notice's Dismiss forgets only this purchase.
      act(() => clearModelUnlockIntent(REQUEST_ID));
      await clickRow(CLAUDE_GATEWAY_ONLY);

      expect(bodyText('model-recovery-unlock-purchase')).toBe('Get AI Credits');
      expect(paymentHandoff).toHaveBeenCalledTimes(1);
    });
  });

  it('draws no purchase lock while access is unknown', () => {
    // Organization-owned work and failed reads land here. The server still
    // enforces; the client must not sell on a guess.
    mockLibraryAccess = undefined;
    stubFundedNonPayer();
    renderPicker(fundedNoProviderLogin(), {
      currentModel: CLAUDE_NON_GATEWAY,
    });
    expect(option(CLAUDE_GATEWAY_ONLY).getAttribute('data-locked')).toBeNull();
  });
});

/**
 * CAN-4703 — the guest gate offers the same vendor's allowed model and selects
 * it in one click on the chat that raised the gate.
 *
 * The baseline fixture spells every gateway id `vendor/…`, which matches no
 * allowlist vendor, so this block re-seeds the DeepSeek routes with real
 * vendor ids: Flash is gated for a guest, Pro is allowlisted.
 */
describe('ModelPicker — guest fallback (CAN-4703)', () => {
  const DEEPSEEK_ROUTES: GatewayRouteEntry[] = GATEWAY_ROUTES.map((route) =>
    route.modelId === CODEX_GATEWAY_ONLY || route.modelId === DEEPSEEK_FLASH
      ? { ...route, gatewayId: `deepseek/${route.modelId}` }
      : route,
  );

  beforeEach(() => {
    mockIsGuest = true;
    initAiGatewayModels(API_GATEWAY_ENTRIES, DEEPSEEK_ROUTES);
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadNativeAiCreditsAvailability: jest.fn().mockResolvedValue({
          personalEligible: true,
          orgSpendable: false,
          inOrg: false,
          orgCreditPoolCovered: false,
          inconclusive: false,
          pricingUrl: 'https://example.test/pricing',
        }),
        loadCanopyCloudAccount: jest.fn().mockResolvedValue(null),
      },
    });
  });

  afterEach(() => {
    registerModelRegistries();
  });

  const codexCredits = (): ProviderAvailability =>
    availability({
      codex: {
        selectable: true,
        nativeAuth: false,
        creditsEligible: true,
        loading: false,
      },
    });

  function renderGuestPicker(extra: {
    readonly currentModel: string;
    readonly onModelChange: (model: string) => void;
    readonly onRestoreFocus?: () => void;
    readonly onRecoveryCommit?: (model: string) => Promise<boolean>;
  }): void {
    render(
      createElement(ModelPicker, {
        currentModel: extra.currentModel,
        onModelChange: extra.onModelChange,
        providerAvailability: codexCredits(),
        ...(extra.onRestoreFocus
          ? { onRestoreFocus: extra.onRestoreFocus }
          : {}),
        ...(extra.onRecoveryCommit
          ? {
              onRecoveryCommit: extra.onRecoveryCommit,
              recoveryChatKey: 'chat-1',
            }
          : {}),
      }),
    );
    openPicker();
  }

  async function settle(run: () => void): Promise<void> {
    await act(async () => {
      run();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function fallbackButton(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(
      '[data-testid="model-recovery-guest-fallback"]',
    );
  }

  it('selects the allowed sibling in one click, closes, and restores focus once', async () => {
    const onModelChange = jest.fn();
    const onRestoreFocus = jest.fn();
    renderGuestPicker({
      currentModel: CLAUDE_NON_GATEWAY,
      onModelChange,
      onRestoreFocus,
    });

    await settle(() => option(DEEPSEEK_FLASH).click());
    expect(
      document.querySelector('[data-testid="model-recovery-needs-account"]')
        ?.textContent,
    ).toContain('As a guest you can use DeepSeek V4 Pro right now.');
    expect(fallbackButton()?.textContent).toBe('Use DeepSeek V4 Pro (free)');

    await settle(() => fallbackButton()?.click());

    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenCalledWith(CODEX_GATEWAY_ONLY);
    expect(recoveryModal()).toBeNull();
    expect(onRestoreFocus).toHaveBeenCalledTimes(1);
  });

  it('commits through the originating chat’s acknowledged path', async () => {
    const onModelChange = jest.fn();
    const onRecoveryCommit = jest.fn(() => Promise.resolve(true));
    renderGuestPicker({
      currentModel: CLAUDE_NON_GATEWAY,
      onModelChange,
      onRecoveryCommit,
    });

    await settle(() => option(DEEPSEEK_FLASH).click());
    await settle(() => fallbackButton()?.click());

    expect(onRecoveryCommit).toHaveBeenCalledTimes(1);
    expect(onRecoveryCommit).toHaveBeenCalledWith(CODEX_GATEWAY_ONLY);
    expect(onModelChange).not.toHaveBeenCalled();
    expect(recoveryModal()).toBeNull();
  });

  it('does not carry the gated row’s explicit harness into the fallback route', async () => {
    const onRecoveryCommit = jest.fn(() => Promise.resolve(true));
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_NON_GATEWAY,
        onModelChange: jest.fn(),
        onRecoveryCommit,
        recoveryChatKey: 'chat-1',
        providerAvailability: codexCredits(),
        browserLayout: 'harnesses',
      }),
    );
    openPicker();
    await settle(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-model-harness-tab-codex"]',
        )
        ?.click(),
    );
    await settle(() => option(DEEPSEEK_FLASH).click());
    expect(fallbackButton()).not.toBeNull();
    await settle(() => fallbackButton()?.click());
    expect(onRecoveryCommit).toHaveBeenCalledWith(CODEX_GATEWAY_ONLY);
  });

  it('keeps the gate open with the row’s reason when the chat refuses', async () => {
    const onRecoveryCommit = jest.fn(() => Promise.resolve(false));
    renderGuestPicker({
      currentModel: CLAUDE_NON_GATEWAY,
      onModelChange: jest.fn(),
      onRecoveryCommit,
    });

    await settle(() => option(DEEPSEEK_FLASH).click());
    await settle(() => fallbackButton()?.click());

    expect(recoveryModal()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-fallback-blocked"]'),
    ).not.toBeNull();
    expect(fallbackButton()?.disabled).toBe(false);
  });

  it.each(['refused', 'rejected'] as const)(
    'preserves the original harness after a %s fallback and sign-in',
    async (failure) => {
      const onRecoveryCommit = jest.fn(() => Promise.resolve(true));
      if (failure === 'refused') onRecoveryCommit.mockResolvedValueOnce(false);
      else onRecoveryCommit.mockRejectedValueOnce(new Error('Commit failed'));
      render(
        createElement(ModelPicker, {
          currentModel: CLAUDE_NON_GATEWAY,
          onModelChange: jest.fn(),
          onRecoveryCommit,
          recoveryChatKey: 'chat-1',
          providerAvailability: codexCredits(),
          browserLayout: 'harnesses',
        }),
      );
      openPicker();
      await settle(() =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="chat-model-harness-tab-codex"]',
          )
          ?.click(),
      );
      await settle(() => option(DEEPSEEK_FLASH).click());
      await settle(() => fallbackButton()?.click());
      expect(onRecoveryCommit).toHaveBeenNthCalledWith(1, CODEX_GATEWAY_ONLY);
      expect(recoveryModal()).not.toBeNull();

      await settle(() =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="model-recovery-account-sign-in"]',
          )
          ?.click(),
      );
      expect(useCloudConnectGateStore.getState().pending).not.toBeNull();
      jest.spyOn(window.api, 'loadCanopyCloudAccount').mockResolvedValue({
        hasApiKey: true,
        account: {
          id: 'acct_1',
          name: 'Account',
          email: 'test@example.com',
          role: 'DEVELOPER',
        },
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        capabilities: [],
        storageAvailable: true,
        orgBillingStates: [],
      });
      await settle(() => useCloudConnectGateStore.getState().resolve());

      expect(onRecoveryCommit).toHaveBeenCalledTimes(2);
      expect(onRecoveryCommit).toHaveBeenNthCalledWith(
        2,
        DEEPSEEK_FLASH,
        undefined,
        'codex',
      );
      expect(recoveryModal()).toBeNull();
    },
  );

  it('offers no fallback when the chat already uses it', async () => {
    renderGuestPicker({
      currentModel: CODEX_GATEWAY_ONLY,
      onModelChange: jest.fn(),
    });

    await settle(() => option(DEEPSEEK_FLASH).click());

    expect(
      document.querySelector('[data-testid="model-recovery-needs-account"]')
        ?.textContent,
    ).toContain('Your guest work comes with you, nothing is lost.');
    expect(fallbackButton()).toBeNull();
  });

  it('offers no fallback for a vendor without an allowed model', async () => {
    renderGuestPicker({
      currentModel: CLAUDE_NON_GATEWAY,
      onModelChange: jest.fn(),
    });

    await settle(() => option(KIMI_K3).click());

    expect(
      document.querySelector('[data-testid="model-recovery-needs-account"]'),
    ).not.toBeNull();
    expect(fallbackButton()).toBeNull();
  });

  it('preserves the previous selection on Not now', async () => {
    const onModelChange = jest.fn();
    const onRestoreFocus = jest.fn();
    renderGuestPicker({
      currentModel: CLAUDE_NON_GATEWAY,
      onModelChange,
      onRestoreFocus,
    });

    await settle(() => option(DEEPSEEK_FLASH).click());
    await settle(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="model-recovery-modal"] button[aria-label="Close"]',
        )
        ?.click(),
    );

    expect(onModelChange).not.toHaveBeenCalled();
    expect(recoveryModal()).toBeNull();
    expect(onRestoreFocus).toHaveBeenCalledTimes(1);
  });

  it.each(['switch', 'unmount'] as const)(
    'does not restore focus after a pending commit and %s',
    async (change) => {
      let finish: (accepted: boolean) => void = () => undefined;
      const onRecoveryCommit = jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      );
      const onRestoreFocus = jest.fn();
      const onModelChange = jest.fn();
      renderGuestPicker({
        currentModel: CLAUDE_NON_GATEWAY,
        onModelChange,
        onRecoveryCommit,
        onRestoreFocus,
      });
      await settle(() => option(DEEPSEEK_FLASH).click());
      await settle(() => fallbackButton()?.click());
      expect(onRecoveryCommit).toHaveBeenCalledTimes(1);
      await settle(() => {
        if (change === 'unmount') {
          root?.unmount();
          root = null;
        } else {
          root?.render(
            createElement(ModelPicker, {
              currentModel: CLAUDE_NON_GATEWAY,
              onModelChange,
              onRecoveryCommit: jest.fn(),
              onRestoreFocus,
              providerAvailability: codexCredits(),
              recoveryChatKey: 'chat-2',
            }),
          );
        }
      });
      await settle(() => finish(true));
      expect(onRestoreFocus).not.toHaveBeenCalled();
      expect(onModelChange).not.toHaveBeenCalled();
    },
  );

  it('redirects changed eligibility without committing, then uses the original chat binding', async () => {
    const originCommit = jest.fn(() => Promise.resolve(true));
    const otherCommit = jest.fn(() => Promise.resolve(true));
    const onRestoreFocus = jest.fn();
    renderGuestPicker({
      currentModel: CLAUDE_NON_GATEWAY,
      onModelChange: jest.fn(),
      onRecoveryCommit: originCommit,
      onRestoreFocus,
    });
    await settle(() => option(DEEPSEEK_FLASH).click());

    let finishRead: (value: NativeAiCreditsAvailability) => void = () =>
      undefined;
    const accountRead = new Promise<NativeAiCreditsAvailability>((resolve) => {
      finishRead = resolve;
    });
    const readSpy = jest
      .spyOn(window.api, 'loadNativeAiCreditsAvailability')
      .mockReturnValue(accountRead);
    invalidateSharedAiCreditsRead();
    const noCredits = availability({
      codex: {
        selectable: false,
        nativeAuth: false,
        creditsEligible: false,
        loading: false,
      },
    });
    const renderChat = (chatKey: string): void => {
      root?.render(
        createElement(ModelPicker, {
          currentModel: CLAUDE_NON_GATEWAY,
          onModelChange: jest.fn(),
          onRecoveryCommit: otherCommit,
          onRestoreFocus,
          recoveryChatKey: chatKey,
          providerAvailability: noCredits,
        }),
      );
    };
    try {
      await settle(() => renderChat('chat-1'));
      await settle(() => fallbackButton()?.click());
      expect(fallbackButton()).toBeNull();
      expect(recoveryModal()).not.toBeNull();
      expect(originCommit).not.toHaveBeenCalled();
      expect(onRestoreFocus).not.toHaveBeenCalled();

      await settle(() => renderChat('chat-2'));
      await settle(() =>
        finishRead({
          personalEligible: true,
          orgSpendable: false,
          inOrg: false,
          orgCreditPoolCovered: false,
          inconclusive: false,
          pricingUrl: 'https://example.test/pricing',
        }),
      );
      expect(originCommit).toHaveBeenCalledTimes(1);
      expect(originCommit).toHaveBeenCalledWith(CODEX_GATEWAY_ONLY);
      expect(otherCommit).not.toHaveBeenCalled();
      expect(onRestoreFocus).not.toHaveBeenCalled();
      expect(recoveryModal()).toBeNull();
    } finally {
      readSpy.mockRestore();
    }
  });
});

/**
 * CAN-3026 §4c — the "manually selected" half of the guest gate.
 *
 * Flipping a chat that sits on a non-allowlisted model ONTO AI Credits routes
 * that model through the lane Canopy pays for, which is exactly what the row
 * gate refuses. It must hit the same prompt.
 */
describe('ModelPicker billing toggle — guest gate (CAN-3026)', () => {
  function withStubbedGate(): {
    requestConnect: jest.Mock;
    contexts: CloudConnectGateContext[];
    restore: () => void;
  } {
    const contexts: CloudConnectGateContext[] = [];
    const requestConnect = jest.fn((context: CloudConnectGateContext): void => {
      contexts.push(context);
    });
    const real = useCloudConnectGateStore.getState().requestConnect;
    act(() => {
      useCloudConnectGateStore.setState({ requestConnect });
    });
    return {
      requestConnect,
      contexts,
      // `act`-wrapped: the store is subscribed by the mounted picker, so a bare
      // `setState` here schedules an unacted React update and warns.
      restore: (): void => {
        act(() => {
          useCloudConnectGateStore.setState({ requestConnect: real });
        });
      },
    };
  }

  it('routes a guest turning AI Credits ON for a blocked model to sign-in', () => {
    mockIsGuest = true;
    const { requestConnect, contexts, restore } = withStubbedGate();
    const onChange = jest.fn();

    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY_ONLY,
      value: 'subscription',
      onChange,
    });

    act(() => {
      billingSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(requestConnect).toHaveBeenCalledTimes(1);
    expect(contexts[0]).toMatchObject({ guestBenefits: true });
    // No silent write behind the sign-in: the user re-flips it themselves.
    expect(onChange).not.toHaveBeenCalled();
    restore();
  });

  it('lets a guest turn AI Credits ON for an allowlisted model', () => {
    // The shipped lane default. Prompting here would hit installed clients
    // that never chose anything.
    mockIsGuest = true;
    const { requestConnect, restore } = withStubbedGate();
    const onChange = jest.fn();

    renderBillingPicker({
      currentModel: CODEX_GATEWAY_ONLY,
      value: 'subscription',
      onChange,
    });

    act(() => {
      billingSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(requestConnect).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('ai-credits');
    restore();
  });

  it('never gates a guest turning AI Credits OFF', () => {
    // Moving a guest back onto their own subscription LOWERS Canopy's cost.
    mockIsGuest = true;
    const { requestConnect, restore } = withStubbedGate();
    const onChange = jest.fn();

    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY_ONLY,
      value: 'ai-credits',
      onChange,
    });

    act(() => {
      billingSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(requestConnect).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('subscription');
    restore();
  });

  it('leaves a signed-in user toggle at zero diff', () => {
    mockIsGuest = false;
    const { requestConnect, restore } = withStubbedGate();
    const onChange = jest.fn();

    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY_ONLY,
      value: 'subscription',
      onChange,
    });

    act(() => {
      billingSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(requestConnect).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('ai-credits');
    restore();
  });
});

describe('ModelPicker harness picker', () => {
  const visible = (testId: string): HTMLElement | null =>
    document.querySelector(`[data-testid="${testId}"]:not([hidden])`);

  const withCredits = (): ProviderAvailability =>
    availability({
      claude: {
        selectable: true,
        nativeAuth: true,
        creditsEligible: true,
        loading: false,
      },
      codex: {
        selectable: true,
        nativeAuth: true,
        creditsEligible: true,
        loading: false,
      },
    });

  function withGatewayOnBothHarnesses(): () => void {
    const previous = useModelCatalogStore.getState();
    const setModelHarness = jest.fn((): Promise<void> => Promise.resolve());
    useModelCatalogStore.setState({
      setModelHarness,
      harnessAssignments: {
        revision: 1,
        assignments: [
          {
            modelId: CODEX_GATEWAY_ONLY,
            source: 'ai-gateway',
            harness: 'codex',
            defaultHarness: 'codex',
            configurable: true,
            overridden: false,
            availableHarnesses: ['claude', 'codex'],
          },
        ],
      },
    });
    return (): void =>
      useModelCatalogStore.setState({
        setModelHarness: previous.setModelHarness,
        harnessAssignments: previous.harnessAssignments,
      });
  }

  it('runs a credits model on the harness tab it was picked from', () => {
    const restore = withGatewayOnBothHarnesses();
    try {
      const onModelChange = jest.fn();
      renderPicker(withCredits(), {
        browserLayout: 'harnesses',
        onModelChange,
      });
      act(() => visible('chat-model-harness-tab-claude')?.click());
      act(() => visible(`chat-model-option-${CODEX_GATEWAY_ONLY}`)?.click());
      expect(onModelChange).toHaveBeenLastCalledWith(
        CODEX_GATEWAY_ONLY,
        undefined,
        'claude',
      );
    } finally {
      restore();
    }
  });

  it("does not re-assert a started chat's own harness for a credits pick", () => {
    // Main refuses any explicit harness on a started chat ("Start a new chat
    // to change its harness"), even the one it already runs on, so naming the
    // locked harness silently dropped the pick.
    const onModelChange = jest.fn();
    renderPicker(withCredits(), {
      browserLayout: 'harnesses',
      currentModel: CODEX_GATEWAY,
      lockedProvider: 'codex',
      lockedHarness: 'codex',
      lockedProviderBehavior: 'continue',
      onModelChange,
    });
    act(() => visible('chat-model-harness-tab-all')?.click());
    act(() => visible(`chat-model-option-${CODEX_GATEWAY_ONLY}`)?.click());
    expect(onModelChange).toHaveBeenLastCalledWith(CODEX_GATEWAY_ONLY);
  });

  it('lists a hosted model only under its assigned harness in a started chat', () => {
    // A started chat cannot re-assign a model's harness: main would run a
    // Codex-assigned model on Codex, so the Claude tab must not offer it.
    const restore = withGatewayOnBothHarnesses();
    try {
      renderPicker(withCredits(), {
        browserLayout: 'harnesses',
        currentModel: CLAUDE_GATEWAY,
        lockedProvider: 'claude',
        lockedHarness: 'claude',
        lockedProviderBehavior: 'continue',
      });
      act(() => visible('chat-model-harness-tab-claude')?.click());
      expect(visible(`chat-model-option-${CODEX_GATEWAY_ONLY}`)).toBeNull();
      act(() => visible('chat-model-harness-tab-codex')?.click());
      expect(visible(`chat-model-option-${CODEX_GATEWAY_ONLY}`)).not.toBeNull();
    } finally {
      restore();
    }
  });

  it('remembers the harness chosen in All for that model', () => {
    const restore = withGatewayOnBothHarnesses();
    try {
      const onModelChange = jest.fn();
      renderPicker(withCredits(), {
        browserLayout: 'harnesses',
        onModelChange,
      });
      act(() =>
        visible(`chat-model-harness-control-${CODEX_GATEWAY_ONLY}`)?.click(),
      );
      act(() =>
        visible(
          `chat-model-settings-harness-claude-${CODEX_GATEWAY_ONLY}`,
        )?.click(),
      );
      expect(
        useModelCatalogStore.getState().setModelHarness,
      ).toHaveBeenCalledWith(CODEX_GATEWAY_ONLY, 'claude');
      expect(onModelChange).toHaveBeenLastCalledWith(
        CODEX_GATEWAY_ONLY,
        undefined,
        'claude',
      );
    } finally {
      restore();
    }
  });

  it("sets the chat's billing from a model's billing menu", () => {
    const onChange = jest.fn();
    renderBillingPicker({
      currentModel: CLAUDE_GATEWAY,
      value: 'subscription',
      onChange,
      browserLayout: 'harnesses',
    });
    // In All the row's harness icon opens its menu.
    act(() =>
      (
        visible(`chat-model-billing-${CLAUDE_GATEWAY}`) ??
        visible(`chat-model-harness-control-${CLAUDE_GATEWAY}`)
      )?.click(),
    );
    expect(
      visible(
        `chat-model-billing-subscription-${CLAUDE_GATEWAY}`,
      )?.getAttribute('aria-checked'),
    ).toBe('true');
    // No per-model limits fallback exists yet (CAN-3365).
    expect(visible(`chat-model-billing-fallback-${CLAUDE_GATEWAY}`)).toBeNull();
    act(() => visible(`chat-model-billing-credits-${CLAUDE_GATEWAY}`)?.click());
    expect(onChange).toHaveBeenCalledWith('ai-credits');
  });
});

describe('ModelPicker harness picker Cursor tab', () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'discovers disconnected Cursor only after release (master=%s, release=%s)',
    (enabled, released) => {
      const cursorMock = jest.requireMock<{
        useCursorChatAvailable: jest.Mock;
      }>('@/hooks/useCursorChatAvailable');
      cursorMock.useCursorChatAvailable.mockReturnValue(false);
      const snapshot = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.getState().setSnapshot({
        ...snapshot,
        values: {
          ...snapshot.values,
          'canopy-desktop-cursor-harness': enabled,
          'canopy-desktop-cursor-harness-released': released,
        },
      });
      const openSettings = jest.fn();
      const previous = useNavigationStore.getState().openSettings;
      useNavigationStore.setState({ openSettings });
      try {
        render(
          createElement(ModelPicker, {
            currentModel: CLAUDE_GATEWAY,
            onModelChange: (): void => {},
            browserLayout: 'harnesses',
            allowCursor: true,
          }),
        );
        openPicker();
        const tab = document.querySelector<HTMLElement>(
          '[data-testid="chat-model-harness-tab-cursor"]',
        );
        if (!enabled || !released) {
          expect(tab).toBeNull();
          return;
        }
        expect(tab?.getAttribute('aria-label')).toContain('Connect');
        act(() => tab?.click());
        act(() =>
          document
            .querySelector<HTMLElement>(
              '[data-testid="chat-model-connect-harness"]',
            )
            ?.click(),
        );
        expect(openSettings).toHaveBeenCalledWith('account');
      } finally {
        useFeatureFlagsStore.getState().setSnapshot(snapshot);
        useNavigationStore.setState({ openSettings: previous });
        cursorMock.useCursorChatAvailable.mockImplementation(
          (enabled: boolean) => enabled,
        );
      }
    },
  );
});

describe('ModelPicker harness picker Copilot tab', () => {
  it.each([
    { released: false, section: 'experiments' },
    { released: true, section: 'account' },
  ])(
    'connects disconnected Copilot in $section when released=$released',
    ({ released, section }) => {
      const copilotMock = jest.requireMock<{
        useCopilotChatAvailable: jest.Mock;
      }>('@/hooks/useCopilotChatAvailable');
      copilotMock.useCopilotChatAvailable.mockReturnValue(false);
      const snapshot = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.getState().setSnapshot({
        ...snapshot,
        values: {
          ...snapshot.values,
          'canopy-desktop-copilot-harness': true,
          'canopy-desktop-copilot-harness-released': released,
        },
      });
      const openSettings = jest.fn();
      const previous = useNavigationStore.getState().openSettings;
      useNavigationStore.setState({ openSettings });
      try {
        render(
          createElement(ModelPicker, {
            currentModel: CLAUDE_GATEWAY,
            onModelChange: (): void => {},
            browserLayout: 'harnesses',
            allowCopilot: true,
          }),
        );
        openPicker();
        const tab = document.querySelector<HTMLElement>(
          '[data-testid="chat-model-harness-tab-copilot"]',
        );
        expect(tab?.getAttribute('aria-label')).toContain('Connect');
        act(() => tab?.click());
        act(() =>
          document
            .querySelector<HTMLElement>(
              '[data-testid="chat-model-connect-harness"]',
            )
            ?.click(),
        );
        expect(openSettings).toHaveBeenCalledWith(section);
      } finally {
        useFeatureFlagsStore.getState().setSnapshot(snapshot);
        useNavigationStore.setState({ openSettings: previous });
        copilotMock.useCopilotChatAvailable.mockImplementation(
          (enabled: boolean) => enabled,
        );
      }
    },
  );
});

describe('ModelPicker harness picker OpenCode tab', () => {
  it.each([
    { released: false, section: 'experiments' },
    { released: true, section: 'account' },
  ])(
    'connects disconnected OpenCode in $section when released=$released',
    ({ released, section }) => {
      const opencodeMock = jest.requireMock<{
        useOpenCodeChatAvailable: jest.Mock;
      }>('@/hooks/useOpenCodeChatAvailable');
      opencodeMock.useOpenCodeChatAvailable.mockReturnValue(false);
      const snapshot = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.getState().setSnapshot({
        ...snapshot,
        values: {
          ...snapshot.values,
          'canopy-desktop-opencode-harness': true,
          'canopy-desktop-opencode-harness-released': released,
        },
      });
      const openSettings = jest.fn();
      const previous = useNavigationStore.getState().openSettings;
      useNavigationStore.setState({ openSettings });
      try {
        render(
          createElement(ModelPicker, {
            currentModel: CLAUDE_GATEWAY,
            onModelChange: (): void => {},
            browserLayout: 'harnesses',
            allowOpenCode: true,
          }),
        );
        openPicker();
        const tab = document.querySelector<HTMLElement>(
          '[data-testid="chat-model-harness-tab-opencode"]',
        );
        expect(tab?.getAttribute('aria-label')).toContain('Connect');
        act(() => tab?.click());
        act(() =>
          document
            .querySelector<HTMLElement>(
              '[data-testid="chat-model-connect-harness"]',
            )
            ?.click(),
        );
        expect(openSettings).toHaveBeenCalledWith(section);
      } finally {
        useFeatureFlagsStore.getState().setSnapshot(snapshot);
        useNavigationStore.setState({ openSettings: previous });
        opencodeMock.useOpenCodeChatAvailable.mockImplementation(
          (enabled: boolean) => enabled,
        );
      }
    },
  );
});

describe('ModelPicker harness picker billing', () => {
  it.each(['claude', 'codex'] as const)(
    'opens the %s sign-in remedy from a credits-locked harness picker (CAN-5349)',
    (provider) => {
      const model = provider === 'claude' ? CLAUDE_GATEWAY : CODEX_GATEWAY;
      const providers = availability({
        [provider]: {
          selectable: true,
          nativeAuth: false,
          nativeAuthInconclusive: false,
          creditsEligible: true,
          loading: false,
        },
      });
      const resolution = resolveChatBillingFramework({
        model,
        provider,
        availability: providers[provider],
        aiCreditsRoutingActive: true,
        subscriptionBillingOverride: false,
        routingActiveForChat: false,
      });
      const onChange = jest.fn();
      render(
        createElement(ModelPicker, {
          currentModel: model,
          onModelChange: jest.fn(),
          browserLayout: 'harnesses',
          providerAvailability: providers,
          billing: {
            value: 'ai-credits',
            provider,
            disabled: resolution.toggleDisabled,
            lockKind: resolution.lockKind,
            lockedReason: resolution.lockedReason,
            onChange,
          },
        }),
      );
      openPicker();
      const cta = document.querySelector<HTMLButtonElement>(
        '[data-testid="chat-billing-sign-in"]',
      );
      expect(cta).not.toBeNull();
      expect(cta?.textContent).toContain(
        provider === 'claude' ? 'Sign in to Claude' : 'Sign in to Codex',
      );
      act(() => cta?.click());
      const modal = document.querySelector('[data-testid="auth-login-modal"]');
      expect(modal?.getAttribute('data-provider')).toBe(provider);
      expect(
        document.querySelector('[data-testid="chat-billing-sign-in"]'),
      ).toBeNull();
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it('persists an explicit equal-value subscription choice after negative auth with no credits', async () => {
    const previous = useChatStore.getState();
    const target = {
      projectId: 'billing-project',
      worktreeId: 'billing-worktree',
      chatId: 'billing-chat',
    };
    const tab: ChatTab = {
      id: target.chatId,
      title: 'Chat',
      messages: [],
      status: 'idle',
      error: null,
      createdAt: '2026-10-27T00:00:00.000Z',
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: {
        thinkingLevel: 'high',
        fastMode: false,
        speed: 'standard',
      },
      fastModeExplicit: false,
      model: CLAUDE_GATEWAY,
      providerType: 'claude',
    };
    const dispatchChatCommand = jest
      .fn<
        ReturnType<typeof previous.dispatchChatCommand>,
        Parameters<typeof previous.dispatchChatCommand>
      >()
      .mockResolvedValue('accepted');
    const rememberBillingFramework = jest.fn();
    const providers = availability({});
    const resolution = resolveChatBillingFramework({
      model: tab.model,
      provider: 'claude',
      availability: providers.claude,
      aiCreditsRoutingActive: false,
      subscriptionBillingOverride: false,
      routingActiveForChat: false,
    });
    expect(resolution).toMatchObject({
      framework: 'subscription',
      toggleDisabled: true,
      lockKind: 'no-credits',
    });
    act(() =>
      useChatStore.setState({
        worktreeChats: {
          'billing-project/billing-worktree': {
            activeTabId: tab.id,
            tabs: [tab],
          },
        },
        chatStateSync: {
          'billing-project/billing-worktree': { phase: 'live', revision: 1 },
        },
        dispatchChatCommand,
        rememberBillingFramework,
      }),
    );
    const onChange = jest.fn((framework: 'subscription' | 'ai-credits') => {
      useChatStore.getState().selectBillingFramework(framework, target);
    });
    try {
      render(
        createElement(ModelPicker, {
          currentModel: CLAUDE_GATEWAY,
          onModelChange: jest.fn(),
          browserLayout: 'harnesses',
          providerAvailability: providers,
          billing: {
            value: 'subscription',
            provider: 'claude',
            disabled: resolution.toggleDisabled,
            lockKind: resolution.lockKind,
            onChange,
          },
        }),
      );
      openPicker();
      const visible = (id: string): HTMLElement | null =>
        document.querySelector(`[data-testid="${id}"]:not([hidden] *)`);
      act(() =>
        (
          visible(`chat-model-billing-${CLAUDE_GATEWAY}`) ??
          visible(`chat-model-harness-control-${CLAUDE_GATEWAY}`)
        )?.click(),
      );
      const subscription = visible(
        `chat-model-billing-subscription-${CLAUDE_GATEWAY}`,
      );
      expect(subscription).not.toBeNull();
      await act(async () => {
        subscription?.click();
        await Promise.resolve();
      });
      expect(onChange).toHaveBeenCalledWith('subscription');
      expect(
        useChatStore.getState().worktreeChats[
          'billing-project/billing-worktree'
        ]?.tabs[0],
      ).toMatchObject({
        subscriptionBillingOverride: true,
        billingExplicitlyChosen: true,
      });
      const rollbackMatcher: unknown = expect.any(Function);
      expect(dispatchChatCommand).toHaveBeenCalledWith(
        { projectId: target.projectId, worktreeId: target.worktreeId },
        {
          type: 'chat.patch_tab_settings',
          tabId: tab.id,
          patch: {
            subscriptionBillingOverride: true,
            aiCreditsRouting: null,
            billingExplicitlyChosen: true,
          },
        },
        expect.objectContaining({ rollback: rollbackMatcher }),
      );
      expect(
        dispatchChatCommand.mock.calls.every(
          ([, command]) => command.type === 'chat.patch_tab_settings',
        ),
      ).toBe(true);
    } finally {
      act(() => useChatStore.setState(previous, true));
    }
  });

  it('keeps the hosted credits gate when the no-credits subscription menu is reachable', async () => {
    const onChange = jest.fn();
    const onModelChange = jest.fn();
    const previousApi = window.api;
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadNativeAiCreditsAvailability: jest.fn().mockResolvedValue({
          personalEligible: false,
          orgSpendable: false,
          inOrg: false,
          orgCreditPoolCovered: false,
          inconclusive: false,
          pricingUrl: 'https://example.test/pricing',
        }),
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          account: { id: 'acct_1' },
          authMode: 'account',
          credentialSource: 'account',
          orgBillingStates: [],
        }),
      },
    });
    try {
      render(
        createElement(ModelPicker, {
          currentModel: CLAUDE_GATEWAY,
          onModelChange,
          browserLayout: 'harnesses',
          providerAvailability: availability({}),
          billing: {
            value: 'subscription',
            provider: 'claude',
            disabled: true,
            lockKind: 'no-credits',
            onChange,
          },
        }),
      );
      openPicker();
      const visible = (id: string): HTMLElement | null =>
        document.querySelector(`[data-testid="${id}"]:not([hidden] *)`);
      act(() =>
        (
          visible(`chat-model-billing-${CLAUDE_GATEWAY}`) ??
          visible(`chat-model-harness-control-${CLAUDE_GATEWAY}`)
        )?.click(),
      );
      const credits = visible(`chat-model-billing-credits-${CLAUDE_GATEWAY}`);
      expect(credits).not.toBeNull();
      await act(async () => {
        credits?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(recoveryModal()).not.toBeNull();
      expect(onChange).not.toHaveBeenCalled();
      expect(onModelChange).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'api', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });

  it.each([
    ['confirmed native auth', CLAUDE_GATEWAY, 'no-credits', true, false],
    [
      'already explicit subscription',
      CLAUDE_GATEWAY,
      'no-credits',
      false,
      true,
    ],
    [
      'gateway-only lock',
      CLAUDE_GATEWAY_ONLY,
      'gateway-only-model',
      false,
      false,
    ],
    [
      'non-routable lock',
      CLAUDE_NON_GATEWAY,
      'model-not-routable',
      false,
      false,
    ],
    ['another billing lock', CLAUDE_GATEWAY, undefined, false, false],
  ] as const)(
    'does not reopen the subscription action for %s',
    (_label, model, lockKind, nativeAuth, allowUnverifiedSubscription) => {
      render(
        createElement(ModelPicker, {
          currentModel: model,
          onModelChange: jest.fn(),
          browserLayout: 'harnesses',
          providerAvailability: availability({
            claude: {
              selectable: nativeAuth,
              nativeAuth,
              creditsEligible: false,
              loading: false,
            },
          }),
          billing: {
            value: 'subscription',
            provider: 'claude',
            disabled: true,
            lockKind,
            allowUnverifiedSubscription,
            onChange: jest.fn(),
          },
        }),
      );
      openPicker();
      act(() =>
        document
          .querySelector<HTMLElement>(
            `[data-testid="chat-model-harness-control-${model}"]:not([hidden] *)`,
          )
          ?.click(),
      );
      expect(
        document.querySelector(
          `[data-testid="chat-model-billing-subscription-${model}"]:not([hidden] *)`,
        ),
      ).toBeNull();
    },
  );

  it('keeps the Auto row like the lab: no menu, and no chat-wide footer', () => {
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: (): void => {},
        browserLayout: 'harnesses',
        auto: { selected: true, onSelect: (): void => {} },
        billing: {
          value: 'subscription',
          onChange: (): void => {},
          provider: 'claude',
        },
      }),
    );
    openPicker();
    expect(
      document.querySelector('[data-testid="chat-billing-framework"]'),
    ).toBeNull();
    // Auto follows the chat's billing; it has no ••• of its own.
    expect(
      document.querySelector('[data-testid="chat-model-billing-auto"]'),
    ).toBeNull();
    // Native models still carry the billing menu, opened from their harness
    // icon in All.
    expect(
      document.querySelector(
        `[data-testid="chat-model-billing-${CLAUDE_GATEWAY}"], [data-testid="chat-model-harness-control-${CLAUDE_GATEWAY}"]`,
      ),
    ).not.toBeNull();
  });
});

describe('ModelPicker Auto unavailable action', () => {
  const signedIn = availability({
    claude: {
      selectable: true,
      nativeAuth: true,
      creditsEligible: false,
      loading: false,
    },
  });

  function autoRow(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-option-auto"]',
    );
  }

  it('turns the host reason into its fix instead of selecting Auto', () => {
    const onSelect = jest.fn();
    const onUnavailableAction = jest.fn();
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: (): void => {},
        providerAvailability: signedIn,
        auto: {
          selected: false,
          onSelect,
          unavailableReason: MODEL_PICKER_AUTO_REASONS.noCredits,
          unavailableAction: onUnavailableAction,
        },
      }),
    );
    openPicker();
    expect(autoRow()?.getAttribute('role')).toBe('menuitem');
    act(() => {
      autoRow()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onUnavailableAction).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps an action-less reason a disabled radio row', () => {
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_GATEWAY,
        onModelChange: (): void => {},
        providerAvailability: signedIn,
        auto: {
          selected: false,
          onSelect: (): void => {},
          unavailableReason: MODEL_PICKER_AUTO_REASONS.creditsLoading,
        },
      }),
    );
    openPicker();
    expect(autoRow()?.getAttribute('role')).toBe('menuitemradio');
    expect(autoRow()?.disabled).toBe(true);
  });
});

describe('ModelPicker harness browser offers Cursor inside the picker', () => {
  const visible = (testId: string): HTMLElement | null =>
    document.querySelector(`[data-testid="${testId}"]:not([hidden])`);
  const rawModelId = `${CODEX_NON_GATEWAY}[reasoning=medium]`;
  const cursorId = `cursor:${encodeURIComponent(rawModelId)}`;

  function renderBrowser(onModelChange: jest.Mock = jest.fn()): void {
    render(
      createElement(ModelPicker, {
        currentModel: CODEX_NON_GATEWAY,
        onModelChange,
        allowCursor: true,
        browserLayout: 'harnesses',
      }),
    );
  }

  beforeEach(() => {
    initCursorModels([{ id: cursorId, rawModelId, label: 'Cursor variant' }]);
  });

  afterEach(() => {
    initCursorModels([]);
    initModelHarnessAssignments({ revision: 0, assignments: [] });
  });

  it('has no separate harness pill beside the model', () => {
    renderBrowser();
    expect(
      document.querySelector('[data-testid="chat-harness-picker"]'),
    ).toBeNull();
  });

  it('reopens a saved Cursor base model on its remembered harness tab', () => {
    window.localStorage.setItem(
      'unstoppable:model-picker-favorites:selection-tab',
      JSON.stringify({ modelId: CODEX_NON_GATEWAY, tab: 'cursor' }),
    );
    render(
      createElement(ModelPicker, {
        currentModel: cursorId,
        onModelChange: jest.fn(),
        allowCursor: true,
        allowCopilot: true,
        allowOpenCode: true,
        hideAgents: true,
        browserLayout: 'harnesses',
        triggerTooltip: 'Model this agent is built on',
      }),
    );
    openPicker();
    expect(
      visible('chat-model-harness-tab-cursor')?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      visible(`chat-model-option-${CODEX_NON_GATEWAY}`)?.getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    act(() => visible('chat-model-picker')?.click());
    openPicker();
    expect(
      visible('chat-model-harness-tab-cursor')?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  it.each([
    ['tab', false],
    ['tab', true],
    ['search group', true],
  ] as const)(
    'honors the Claude %s from a Cursor Claude model (started: %s)',
    (choice, started) => {
      const raw = `${CLAUDE_GATEWAY}[thinking=true]`;
      const cursorClaude = `cursor:${encodeURIComponent(raw)}`;
      initCursorModels([
        { id: cursorClaude, rawModelId: raw, label: 'Cursor Opus' },
      ]);
      const onModelChange = jest.fn();
      const onStartNewChat = jest.fn();
      render(
        createElement(ModelPicker, {
          currentModel: cursorClaude,
          onModelChange,
          onStartNewChat,
          allowCursor: true,
          browserLayout: 'harnesses',
          providerAvailability: availability({
            claude: {
              selectable: true,
              nativeAuth: true,
              creditsEligible: false,
              loading: false,
            },
          }),
          ...(started
            ? { lockedHarness: 'cursor', lockedProvider: 'cursor' }
            : {}),
        }),
      );
      openPicker();
      if (choice === 'tab') {
        act(() => visible('chat-model-harness-tab-claude')?.click());
      } else {
        const search = visible('chat-model-search');
        if (!(search instanceof HTMLInputElement))
          throw new Error('Missing search');
        act(() => {
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )?.set?.call(search, 'Opus');
          search.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      const row =
        choice === 'tab'
          ? visible(`chat-model-option-${CLAUDE_GATEWAY}`)
          : document.querySelector<HTMLElement>(
              `[role="group"][aria-label="Claude"] [data-testid="chat-model-option-${CLAUDE_GATEWAY}"]`,
            );
      expect(row).not.toBeNull();
      act(() => row?.click());
      if (started) {
        expect(recoveryModal()).not.toBeNull();
        expect(recoveryModal()?.textContent).toContain(
          'Start a new chat with the Claude harness?',
        );
        expect(visible('model-recovery-new-chat-body')?.textContent).toBe(
          "This chat uses the Cursor harness and can't switch to the Claude harness. Starting a new chat leaves this one unchanged.",
        );
        expect(onModelChange).not.toHaveBeenCalled();
        act(() => visible('model-recovery-start-new-chat')?.click());
        expect(onStartNewChat).toHaveBeenCalledWith(CLAUDE_GATEWAY);
      } else {
        expect(onModelChange).toHaveBeenCalledWith(CLAUDE_GATEWAY);
        expect(onStartNewChat).not.toHaveBeenCalled();
      }
    },
  );

  it("lists a model Cursor also runs once on the Cursor tab and runs Cursor's copy from there", () => {
    const onModelChange = jest.fn();
    renderBrowser(onModelChange);
    openPicker();
    act(() => visible('chat-model-harness-tab-cursor')?.click());
    expect(visible(`chat-model-option-${CODEX_NON_GATEWAY}`)).not.toBeNull();
    expect(visible(`chat-model-option-${cursorId}`)).toBeNull();
    act(() => visible(`chat-model-option-${CODEX_NON_GATEWAY}`)?.click());
    expect(onModelChange).toHaveBeenLastCalledWith(cursorId);
  });

  it('runs the model on its own harness from its own tab even when Cursor is its saved default', () => {
    initModelHarnessAssignments({
      revision: 1,
      assignments: [
        {
          modelId: CODEX_NON_GATEWAY,
          source: 'codex-managed',
          harness: 'cursor',
          defaultHarness: 'codex',
          configurable: true,
          overridden: true,
        },
      ],
    });
    const onModelChange = jest.fn();
    renderBrowser(onModelChange);
    openPicker();
    act(() => visible('chat-model-harness-tab-codex')?.click());
    act(() => visible(`chat-model-option-${CODEX_NON_GATEWAY}`)?.click());
    expect(onModelChange).toHaveBeenLastCalledWith(CODEX_NON_GATEWAY);
  });

  it("keeps All on the model's own harness and switches a favorite to Cursor", () => {
    window.localStorage.clear();
    const onModelChange = jest.fn();
    renderBrowser(onModelChange);
    openPicker();
    act(() => visible('chat-model-harness-tab-all')?.click());
    expect(
      visible(`chat-model-harness-control-${CODEX_NON_GATEWAY}`),
    ).toBeNull();
    expect(
      visible(`chat-model-harness-icon-${CODEX_NON_GATEWAY}`)?.getAttribute(
        'data-harness',
      ),
    ).toBe('codex');
    act(() => visible('chat-model-harness-tab-codex')?.click());
    act(() => visible(`chat-model-favorite-${CODEX_NON_GATEWAY}`)?.click());
    act(() => visible('chat-model-harness-tab-favorites')?.click());
    act(() =>
      visible(`chat-model-harness-control-${CODEX_NON_GATEWAY}`)?.click(),
    );
    act(() =>
      visible(
        `chat-model-settings-harness-cursor-${CODEX_NON_GATEWAY}`,
      )?.click(),
    );
    act(() => visible(`chat-model-option-${CODEX_NON_GATEWAY}`)?.click());
    expect(onModelChange).toHaveBeenLastCalledWith(cursorId);
  });

  it('lets a new chat pick the harness for a local Ollama model', () => {
    const previous = useModelCatalogStore.getState().harnessAssignments;
    act(() => {
      useModelCatalogStore.setState({
        harnessAssignments: {
          revision: 1,
          assignments: [
            {
              modelId: OLLAMA_MODEL,
              source: 'ollama',
              harness: 'codex',
              defaultHarness: 'codex',
              configurable: true,
              overridden: false,
              availableHarnesses: ['claude', 'codex'],
            },
          ],
        },
      });
    });
    try {
      const onModelChange = jest.fn();
      renderBrowser(onModelChange);
      openPicker();
      act(() => visible('chat-model-harness-tab-claude')?.click());
      act(() => visible(`chat-model-option-${OLLAMA_MODEL}`)?.click());
      expect(onModelChange).toHaveBeenLastCalledWith(
        OLLAMA_MODEL,
        undefined,
        'claude',
      );
    } finally {
      act(() => {
        useModelCatalogStore.setState({ harnessAssignments: previous });
      });
    }
  });

  it.each(['claude', 'codex'] as const)(
    "shows a new chat's %s harness for a hosted model on the trigger",
    (executionHarness) => {
      render(
        createElement(ModelPicker, {
          currentModel: GLM,
          onModelChange: jest.fn(),
          allowCursor: true,
          browserLayout: 'harnesses',
          executionHarness,
        }),
      );
      expect(
        document
          .querySelector('[data-testid="chat-model-picker-provider-icon"]')
          ?.getAttribute('data-provider'),
      ).toBe(executionHarness);
    },
  );

  it("keeps App Advisor's harness action working without the pill", () => {
    const onModelChange = jest.fn();
    renderBrowser(onModelChange);
    const pickerId = Object.keys(useCurrentUiStateStore.getState().slices)
      .find((key) => key.startsWith('chat.harnessPicker.'))
      ?.slice('chat.harnessPicker.'.length);
    if (!pickerId) throw new Error('Missing reported harness picker');
    // jsdom has no layout; the picker is on screen.
    Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
      configurable: true,
      value: () => true,
    });
    try {
      act(() => {
        expect(dispatchChatHarnessAction(pickerId, 'cursor')).toBe(true);
      });
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'checkVisibility');
    }
    expect(onModelChange).toHaveBeenLastCalledWith(cursorId);
  });

  it("shows Cursor's status only in Cursor's own section", () => {
    mockCursorMessage = 'Loading Cursor models…';
    const visibleStatus = (): Element | undefined =>
      Array.from(
        document.querySelectorAll('[data-testid="cursor-models-status"]'),
      ).find((node) => node.closest('[hidden]') === null);
    renderBrowser();
    openPicker();
    act(() => visible('chat-model-harness-tab-claude')?.click());
    expect(visibleStatus()).toBeUndefined();
    act(() => visible('chat-model-harness-tab-cursor')?.click());
    expect(visibleStatus()?.textContent).toBe('Loading Cursor models…');
  });

  it.each([
    'Loading Cursor models…',
    'Could not load Cursor models. Reopen this menu to try again.',
  ])('explains Cursor discovery inside the picker: %s', (message) => {
    mockCursorMessage = message;
    renderBrowser();
    openPicker();
    act(() => visible('chat-model-harness-tab-cursor')?.click());
    expect(
      document.querySelector('[data-testid="cursor-models-status"]')
        ?.textContent,
    ).toBe(message);
  });

  it("runs a hosted model picked from the Cursor tab on Cursor's copy", () => {
    const hostedRaw = `${GLM}[reasoning=high]`;
    const hostedCursorId = `cursor:${encodeURIComponent(hostedRaw)}`;
    initAiGatewayModels(
      API_GATEWAY_ENTRIES.map((entry) =>
        entry.id === GLM ? { ...entry, cursorModelId: GLM } : entry,
      ),
      GATEWAY_ROUTES,
    );
    initCursorModels([
      { id: hostedCursorId, rawModelId: hostedRaw, label: 'GLM 5.2' },
    ]);
    const previous = useModelCatalogStore.getState().harnessAssignments;
    useModelCatalogStore.setState({
      harnessAssignments: {
        revision: 1,
        assignments: [
          {
            modelId: GLM,
            source: 'ai-gateway',
            harness: 'codex',
            defaultHarness: 'codex',
            configurable: true,
            overridden: false,
            availableHarnesses: ['claude', 'codex', 'cursor'],
          },
        ],
      },
    });
    try {
      const onModelChange = jest.fn();
      renderBrowser(onModelChange);
      openPicker();
      act(() => visible('chat-model-harness-tab-cursor')?.click());
      expect(visible(`chat-model-option-${hostedCursorId}`)).toBeNull();
      act(() => visible(`chat-model-option-${GLM}`)?.click());
      expect(onModelChange).toHaveBeenLastCalledWith(hostedCursorId);
    } finally {
      act(() => {
        useModelCatalogStore.setState({ harnessAssignments: previous });
      });
      registerModelRegistries();
    }
  });
});

describe('ModelPicker OpenCode captured harness', () => {
  const visible = (id: string): HTMLElement | null =>
    document.querySelector(`[data-testid="${id}"]:not([hidden])`);

  function renderOpenCodeRecovery(onModelChange: jest.Mock): void {
    mockOpenCodeAvailable = true;
    const assignments: ModelHarnessAssignment[] = [
      {
        modelId: CLAUDE_GATEWAY,
        source: 'claude-managed',
        harness: 'claude',
        defaultHarness: 'claude',
        configurable: false,
        overridden: false,
        availableHarnesses: ['claude'],
        chatHarnesses: ['claude', 'opencode'],
      },
    ];
    initModelHarnessAssignments({ revision: 1, assignments });
    useModelCatalogStore.setState({
      harnessAssignments: { revision: 1, assignments },
    });
    render(
      createElement(ModelPicker, {
        currentModel: CLAUDE_NON_GATEWAY,
        onModelChange,
        allowOpenCode: true,
        browserLayout: 'harnesses',
        providerAvailability: availability({
          claude: {
            selectable: true,
            nativeAuth: false,
            creditsEligible: true,
            loading: false,
          },
        }),
      }),
    );
    openPicker();
    act(() => visible('chat-model-harness-tab-opencode')?.click());
  }

  function stubOpenCodeRecoveryAccount(access: ModelLibraryAccess): void {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadNativeAiCreditsAvailability: jest.fn().mockResolvedValue({
          personalEligible: true,
          orgSpendable: false,
          inOrg: false,
          orgCreditPoolCovered: false,
          inconclusive: false,
          pricingUrl: 'https://example.test/pricing',
        }),
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          account: { id: 'acct_1' },
          authMode: 'oauth',
          credentialSource: 'oauth',
          orgBillingStates: [],
        }),
        loadCanopyCloudEntitlements: jest.fn().mockResolvedValue({
          resolved: true,
          modelLibrary: { status: 'reported', access },
          modelLibraryAccountKey: 'account:acct_1',
          workModelLibrary: { status: 'reported', access },
          modelLibraryOwnerKey: 'personal',
        }),
      },
    });
  }

  it('keeps managed OpenCode purchase-gated for a funded non-payer', async () => {
    mockLibraryAccess = 'needs_purchase';
    stubOpenCodeRecoveryAccount('needs_purchase');
    const previous = useModelCatalogStore.getState().harnessAssignments;
    try {
      const onModelChange = jest.fn();
      renderOpenCodeRecovery(onModelChange);
      const row = visible(`chat-model-option-${CLAUDE_GATEWAY}`);
      expect(row).not.toBeNull();
      expect(row?.getAttribute('data-locked')).toBe('true');
      await act(async () => {
        row?.click();
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      });
      expect(recoveryModal()?.querySelector('h2')?.textContent).toBe(
        'Unlock Opus',
      );
      expect(onModelChange).not.toHaveBeenCalled();
    } finally {
      act(() =>
        useModelCatalogStore.setState({ harnessAssignments: previous }),
      );
    }
  });

  it('retains OpenCode when a library unlock completes after the row was rendered', async () => {
    mockIsGuest = true;
    // The row still reflects the guest. Recovery reads the signed-in account
    // that has since gained library access, and must retain the chosen harness.
    stubOpenCodeRecoveryAccount('unlocked');
    const previous = useModelCatalogStore.getState().harnessAssignments;
    try {
      const onModelChange = jest.fn();
      renderOpenCodeRecovery(onModelChange);
      const row = visible(`chat-model-option-${CLAUDE_GATEWAY}`);
      expect(row?.getAttribute('data-locked')).toBe('true');
      await act(async () => {
        row?.click();
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      });
      expect(onModelChange).toHaveBeenCalledWith(
        CLAUDE_GATEWAY,
        undefined,
        'opencode',
      );
    } finally {
      act(() =>
        useModelCatalogStore.setState({ harnessAssignments: previous }),
      );
    }
  });

  it('selects a funded inherited Agent on its pinned OpenCode route', () => {
    mockOpenCodeAvailable = true;
    initAgentModels([agentEntry({ baseModel: 'default' })]);
    const previous = useModelCatalogStore.getState().harnessAssignments;
    const assignments: ModelHarnessAssignment[] = [
      {
        modelId: CLAUDE_GATEWAY,
        source: 'claude-managed',
        harness: 'claude',
        defaultHarness: 'claude',
        configurable: false,
        overridden: false,
        availableHarnesses: ['claude'],
        chatHarnesses: ['claude', 'opencode'],
      },
    ];
    initModelHarnessAssignments({ revision: 1, assignments });
    useModelCatalogStore.setState({
      harnessAssignments: { revision: 1, assignments },
    });
    try {
      const onModelChange = jest.fn();
      render(
        createElement(ModelPicker, {
          currentModel: CLAUDE_GATEWAY,
          inheritedDefaultModel: CLAUDE_GATEWAY,
          onModelChange,
          allowOpenCode: true,
          browserLayout: 'harnesses',
          providerAvailability: availability({
            claude: {
              selectable: true,
              nativeAuth: false,
              creditsEligible: true,
              loading: false,
            },
          }),
        }),
      );
      openPicker();
      act(() => visible('chat-model-harness-tab-opencode')?.click());
      const row = visible(`chat-model-option-${AGENT_ID}`);
      expect(row).not.toBeNull();
      act(() => row?.click());
      expect(onModelChange).toHaveBeenCalledWith(
        AGENT_ID,
        undefined,
        'opencode',
      );
      expect(
        document.querySelector('[data-testid="model-recovery-modal"]'),
      ).toBeNull();
    } finally {
      act(() =>
        useModelCatalogStore.setState({ harnessAssignments: previous }),
      );
      initAgentModels([]);
    }
  });

  it.each([true, false])(
    'keeps a same-model native choice behind the started-chat lock: %s',
    (started) => {
      mockOpenCodeAvailable = true;
      const previous = useModelCatalogStore.getState().harnessAssignments;
      const assignments: ModelHarnessAssignment[] = [
        {
          modelId: CLAUDE_GATEWAY,
          source: 'claude-managed',
          harness: 'claude',
          defaultHarness: 'claude',
          configurable: false,
          overridden: false,
          availableHarnesses: ['claude'],
          chatHarnesses: ['claude', 'opencode'],
        },
      ];
      initModelHarnessAssignments({ revision: 1, assignments });
      useModelCatalogStore.setState({
        harnessAssignments: { revision: 1, assignments },
      });
      try {
        const onModelChange = jest.fn();
        render(
          createElement(ModelPicker, {
            currentModel: CLAUDE_GATEWAY,
            onModelChange,
            executionHarness: 'opencode',
            executionHarnessExplicitlyChosen: true,
            ...(started
              ? {
                  lockedHarness: 'opencode' as const,
                  lockedProvider: 'opencode' as const,
                }
              : {}),
            allowOpenCode: true,
            browserLayout: 'harnesses',
          }),
        );
        openPicker();
        act(() => visible('chat-model-harness-tab-claude')?.click());
        const row = visible(`chat-model-option-${CLAUDE_GATEWAY}`);
        expect(row).not.toBeNull();
        expect(row?.getAttribute('aria-disabled') === 'true').toBe(started);
        act(() => row?.click());
        if (started) expect(onModelChange).not.toHaveBeenCalled();
        else
          expect(onModelChange).toHaveBeenCalledWith(
            CLAUDE_GATEWAY,
            undefined,
            'claude',
          );
      } finally {
        act(() =>
          useModelCatalogStore.setState({ harnessAssignments: previous }),
        );
      }
    },
  );
});

describe.each(['cursor', 'copilot', 'opencode'] as const)(
  'ModelPicker %s shared-model recovery',
  (harness) => {
    const raw =
      harness === 'cursor'
        ? `${CLAUDE_GATEWAY}[thinking=true]`
        : harness === 'copilot'
          ? CLAUDE_GATEWAY
          : `anthropic/${CLAUDE_GATEWAY}`;
    const id = `${harness}:${encodeURIComponent(raw)}`;
    let previousFlags = useFeatureFlagsStore.getState().snapshot;
    beforeEach(() => {
      previousFlags = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.getState().setSnapshot({
        ...previousFlags,
        values: {
          ...previousFlags.values,
          'canopy-desktop-copilot-harness': true,
          'canopy-desktop-opencode-harness': true,
        },
      });
      mockUseRegisteredCursorModels = harness === 'cursor';
      if (harness === 'cursor') {
        initCursorModels([
          {
            id,
            rawModelId: raw,
            label: 'Account Opus',
            supportedThinkingLevels: [],
          },
        ]);
      } else if (harness === 'copilot') {
        initCopilotModels([
          {
            id,
            rawModelId: raw,
            label: 'Account Opus',
            supportsVision: false,
            supportedThinkingLevels: [],
          },
        ]);
      } else {
        initOpenCodeModels([
          {
            id,
            rawModelId: raw,
            label: 'Account Opus',
            supportsVision: false,
            supportedThinkingLevels: [],
          },
        ]);
      }
    });
    afterEach(() => {
      act(() => {
        useFeatureFlagsStore.getState().setSnapshot(previousFlags);
        mockUseRegisteredCursorModels = false;
        if (harness === 'cursor') {
          initCursorModels([]);
        } else if (harness === 'copilot') {
          initCopilotModels([]);
        } else {
          initOpenCodeModels([]);
        }
        registerModelRegistries();
      });
    });
    it.each(['start new chat', 'account removed', 'policy blocked'])(
      'keeps the exact managed recovery route until %s',
      (action) => {
        const onModelChange = jest.fn();
        const onStartNewChat = jest.fn();
        render(
          createElement(ModelPicker, {
            currentModel: CLAUDE_GATEWAY,
            onModelChange,
            onStartNewChat,
            allowCursor: true,
            allowCopilot: true,
            allowOpenCode: true,
            browserLayout: 'harnesses',
            lockedHarness: 'claude',
            lockedProvider: 'claude',
            providerAvailability: availability({
              claude: {
                selectable: true,
                nativeAuth: true,
                creditsEligible: false,
                loading: false,
              },
            }),
          }),
        );
        openPicker();
        const tab = document.querySelector<HTMLElement>(
          `[data-testid="chat-model-harness-tab-${harness}"]`,
        );
        expect(tab).not.toBeNull();
        act(() => tab?.click());
        const rows = document.querySelectorAll<HTMLElement>(
          `[data-testid="chat-model-option-${CLAUDE_GATEWAY}"]:not([hidden])`,
        );
        expect(rows).toHaveLength(1);
        expect(getModelPickerMappings(harness)[CLAUDE_GATEWAY]).toBe(id);
        act(() => rows[0]?.click());
        expect(recoveryModal()).not.toBeNull();
        expect(onModelChange).not.toHaveBeenCalled();
        expect(onStartNewChat).not.toHaveBeenCalled();
        if (action === 'start new chat') {
          act(() =>
            document
              .querySelector<HTMLElement>(
                '[data-testid="model-recovery-start-new-chat"]',
              )
              ?.click(),
          );
          expect(onStartNewChat).toHaveBeenCalledWith(id);
        } else {
          act(() => {
            if (action === 'account removed') {
              if (harness === 'cursor') {
                initCursorModels([]);
              } else if (harness === 'copilot') {
                initCopilotModels([]);
              } else {
                initOpenCodeModels([]);
              }
            }
            useModelCatalogStore.setState({
              policy: new Set(
                action === 'policy blocked'
                  ? [harness === 'cursor' ? `vendor/${CLAUDE_GATEWAY}` : id]
                  : [],
              ),
            });
          });
          expect(recoveryModal()).toBeNull();
          expect(onStartNewChat).not.toHaveBeenCalled();
        }
      },
    );
  },
);

describe.each(['copilot', 'opencode'] as const)(
  'ModelPicker %s canonical rows',
  (harness) => {
    const raw =
      harness === 'copilot' ? CODEX_NON_GATEWAY : `openai/${CODEX_NON_GATEWAY}`;
    const id = `${harness}:${encodeURIComponent(raw)}`;
    const init = harness === 'copilot' ? initCopilotModels : initOpenCodeModels;
    const visible = (testId: string): HTMLElement | null =>
      document.querySelector(`[data-testid="${testId}"]:not([hidden])`);
    beforeEach(() => {
      init([
        {
          id,
          rawModelId: raw,
          label: 'Account duplicate',
          supportsVision: false,
          supportedThinkingLevels: [],
        },
      ]);
      act(() =>
        useFeatureFlagsStore.getState().setSnapshot({
          ...useFeatureFlagsStore.getState().snapshot,
          values: {
            ...useFeatureFlagsStore.getState().snapshot.values,
            'canopy-desktop-copilot-harness': true,
            'canopy-desktop-opencode-harness': true,
          },
        }),
      );
    });
    afterEach(() => {
      init([]);
      registerModelRegistries();
    });
    it('shows one native row and dispatches the exact account route from its tab', () => {
      const onModelChange = jest.fn();
      render(
        createElement(ModelPicker, {
          currentModel: CODEX_NON_GATEWAY,
          onModelChange,
          allowCopilot: true,
          allowOpenCode: true,
          browserLayout: 'harnesses',
        }),
      );
      openPicker();
      expect(visible(`chat-model-harness-tab-${harness}`)).not.toBeNull();
      act(() => visible(`chat-model-harness-tab-${harness}`)?.click());
      expect(visible(`chat-model-option-${id}`)).toBeNull();
      expect(visible(`chat-model-option-${CODEX_NON_GATEWAY}`)).not.toBeNull();
      act(() => visible(`chat-model-option-${CODEX_NON_GATEWAY}`)?.click());
      expect(onModelChange).toHaveBeenLastCalledWith(id);
    });
    it.each(['selection', 'favorites'])(
      'keeps managed %s when native authentication is unavailable',
      (action) => {
        const onModelChange = jest.fn();
        render(
          createElement(ModelPicker, {
            currentModel: CODEX_NON_GATEWAY,
            onModelChange,
            allowCopilot: harness === 'copilot',
            allowOpenCode: harness === 'opencode',
            providerAvailability: availability({}),
            browserLayout: 'harnesses',
          }),
        );
        openPicker();
        act(() => visible(`chat-model-harness-tab-${harness}`)?.click());
        const row = Array.from(
          document.querySelectorAll(
            `[data-testid="chat-model-option-${CODEX_NON_GATEWAY}"]`,
          ),
        ).find((el) => !el.closest('[hidden]'));
        expect(row).toBeDefined();
        if (action === 'favorites') {
          act(() =>
            visible(`chat-model-favorite-${CODEX_NON_GATEWAY}`)?.click(),
          );
          expect(
            JSON.parse(
              localStorage.getItem('unstoppable:model-picker-favorites') ??
                '[]',
            ),
          ).toContain(`${harness}::${CODEX_NON_GATEWAY}`);
        } else {
          act(() => {
            if (row instanceof HTMLElement) row.click();
          });
          expect(onModelChange).toHaveBeenCalledWith(id);
        }
      },
    );
    it.each(['selection', 'removal'])(
      'restores saved account favorites for %s without duplicates or route loss',
      (action) => {
        const saved = [
          `${harness}::${id}`,
          `codex::${CODEX_NON_GATEWAY}`,
          `${harness}::${CODEX_NON_GATEWAY}`,
          'unknown::unlisted-model',
        ];
        localStorage.setItem(
          'unstoppable:model-picker-favorites',
          JSON.stringify(saved),
        );
        const onModelChange = jest.fn();
        render(
          createElement(ModelPicker, {
            currentModel: CODEX_NON_GATEWAY,
            onModelChange,
            allowCopilot: true,
            allowOpenCode: true,
            browserLayout: 'harnesses',
          }),
        );
        openPicker();
        act(() => visible('chat-model-harness-tab-favorites')?.click());
        const rows = Array.from(
          document.querySelectorAll(
            `[data-testid="chat-model-option-${CODEX_NON_GATEWAY}"]`,
          ),
        ).filter(
          (row): row is HTMLElement =>
            row instanceof HTMLElement && !row.closest('[hidden]'),
        );
        expect(rows).toHaveLength(2);
        expect(
          JSON.parse(
            localStorage.getItem('unstoppable:model-picker-favorites') ?? '[]',
          ),
        ).toEqual(saved);
        if (action === 'selection') {
          act(() => rows[0]?.click());
          expect(onModelChange).toHaveBeenLastCalledWith(id);
        } else {
          act(() => visible(`chat-model-harness-tab-${harness}`)?.click());
          const star = visible(`chat-model-favorite-${CODEX_NON_GATEWAY}`);
          expect(star?.getAttribute('aria-label')).toMatch(/^Remove /);
          act(() => star?.click());
          expect(
            JSON.parse(
              localStorage.getItem('unstoppable:model-picker-favorites') ??
                '[]',
            ),
          ).toEqual([`codex::${CODEX_NON_GATEWAY}`, 'unknown::unlisted-model']);
          act(() => visible('chat-model-harness-tab-favorites')?.click());
          act(() => visible(`chat-model-option-${CODEX_NON_GATEWAY}`)?.click());
          expect(onModelChange).toHaveBeenLastCalledWith(CODEX_NON_GATEWAY);
        }
      },
    );
    it('does not switch a saved account favorite to native after its route disappears', () => {
      localStorage.setItem(
        'unstoppable:model-picker-favorites',
        JSON.stringify([`${harness}::${CODEX_NON_GATEWAY}`]),
      );
      const onModelChange = jest.fn();
      const props = {
        currentModel: CODEX_NON_GATEWAY,
        onModelChange,
        allowCopilot: true,
        allowOpenCode: true,
        browserLayout: 'harnesses' as const,
      };
      render(createElement(ModelPicker, props));
      openPicker();
      act(() => visible('chat-model-harness-tab-favorites')?.click());
      act(() => {
        init([]);
        root?.render(createElement(ModelPicker, props));
      });
      const row = Array.from(
        document.querySelectorAll(
          `[data-testid="chat-model-option-${CODEX_NON_GATEWAY}"]`,
        ),
      ).find((el) => !el.closest('[hidden]'));
      expect(row).toBeDefined();
      expect(row?.getAttribute('aria-disabled')).toBe('true');
      act(() => {
        if (row instanceof HTMLElement) row.click();
      });
      expect(onModelChange).not.toHaveBeenCalled();
    });

    it.each(['native', 'hosted'])(
      'keeps the %s account choice in the Agent editor picker without tabs',
      (kind) => {
        const canonical = kind === 'hosted' ? GLM : CODEX_NON_GATEWAY;
        const accountRaw =
          harness === 'copilot' ? canonical : `opencode/${canonical}`;
        const accountId = `${harness}:${encodeURIComponent(accountRaw)}`;
        init([
          {
            id: accountId,
            rawModelId: accountRaw,
            label: 'Account model',
            supportsVision: false,
            supportedThinkingLevels: [],
          },
        ]);
        const onModelChange = jest.fn();
        const props = {
          currentModel: CODEX_NON_GATEWAY,
          onModelChange,
          hideAgents: true,
          allowCursor: true,
          allowCopilot: true,
          allowOpenCode: true,
        };
        render(createElement(ModelPicker, props));
        openPicker();
        expect(visible('chat-model-harness-tab-all')).toBeNull();
        const accountRow = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid]'),
        ).find(
          (element) =>
            element.getAttribute('data-testid') ===
              `chat-model-option-${accountId}` && !element.closest('[hidden]'),
        );
        expect(accountRow).toBeDefined();
        act(() => accountRow?.click());
        expect(onModelChange).toHaveBeenLastCalledWith(accountId);
        act(() => {
          root?.render(
            createElement(ModelPicker, { ...props, currentModel: accountId }),
          );
        });
        openPicker();
        const selectedRow = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid]'),
        ).find(
          (element) =>
            element.getAttribute('data-testid') ===
              `chat-model-option-${accountId}` && !element.closest('[hidden]'),
        );
        expect(selectedRow?.getAttribute('aria-checked')).toBe('true');
        expect(
          visible(`chat-model-option-${canonical}`)?.getAttribute(
            'aria-checked',
          ),
        ).toBe('false');
        if (kind === 'hosted') {
          // Configuration pickers have no credits probe. An explicit hosted
          // choice must keep its credit gate instead of reusing this account.
          expect(
            visible(`chat-model-option-${canonical}`)?.getAttribute(
              'aria-disabled',
            ),
          ).toBe('true');
          act(() => visible(`chat-model-option-${canonical}`)?.click());
          expect(onModelChange).toHaveBeenCalledTimes(1);
          return;
        }
        act(() => visible(`chat-model-option-${canonical}`)?.click());
        expect(onModelChange).toHaveBeenLastCalledWith(canonical);
        act(() => {
          root?.render(
            createElement(ModelPicker, { ...props, currentModel: canonical }),
          );
        });
        openPicker();
        expect(
          visible(`chat-model-option-${canonical}`)?.getAttribute(
            'aria-checked',
          ),
        ).toBe('true');
      },
    );

    it.each(['selection', 'removal'])(
      'keeps the account favorite after its shared catalog row disappears for %s',
      (action) => {
        const accountRaw = harness === 'copilot' ? GLM : `opencode/${GLM}`;
        const accountId = `${harness}:${encodeURIComponent(accountRaw)}`;
        init([
          {
            id: accountId,
            rawModelId: accountRaw,
            label: 'Account model',
            supportsVision: false,
            supportedThinkingLevels: [],
          },
        ]);
        const saved = [
          `${harness}::${GLM}`,
          ...(action === 'removal' ? [`${harness}::${accountId}`] : []),
          'unknown::unlisted-model',
        ];
        localStorage.setItem(
          'unstoppable:model-picker-favorites',
          JSON.stringify(saved),
        );
        const onModelChange = jest.fn();
        const props = {
          currentModel: CODEX_NON_GATEWAY,
          onModelChange,
          allowCopilot: true,
          allowOpenCode: true,
          browserLayout: 'harnesses' as const,
        };
        render(createElement(ModelPicker, props));
        openPicker();
        act(() => visible('chat-model-harness-tab-favorites')?.click());
        expect(visible(`chat-model-option-${GLM}`)).not.toBeNull();
        // Policy refresh removes the hosted row while preserving known identity.
        act(() => {
          initAiGatewayModels([], [], true);
          root?.render(createElement(ModelPicker, props));
        });
        const row = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid]'),
        ).find(
          (el) =>
            el.getAttribute('data-testid') ===
              `chat-model-option-${accountId}` && !el.closest('[hidden]'),
        );
        expect(row).toBeDefined();
        expect(
          JSON.parse(
            localStorage.getItem('unstoppable:model-picker-favorites') ?? '[]',
          ),
        ).toEqual(saved);
        if (action === 'selection') {
          act(() => row?.click());
          expect(onModelChange).toHaveBeenLastCalledWith(accountId);
        } else {
          const star = Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid]'),
          ).find(
            (el) =>
              el.getAttribute('data-testid') ===
                `chat-model-favorite-${accountId}` && !el.closest('[hidden]'),
          );
          expect(star).toBeDefined();
          act(() => star?.click());
          expect(
            JSON.parse(
              localStorage.getItem('unstoppable:model-picker-favorites') ??
                '[]',
            ),
          ).toEqual(['unknown::unlisted-model']);
        }
      },
    );

    it('selects a hosted equivalent through the account without changing to credit billing', () => {
      const hostedRaw = harness === 'copilot' ? GLM : `opencode/${GLM}`;
      const hostedId = `${harness}:${encodeURIComponent(hostedRaw)}`;
      init([
        {
          id: hostedId,
          rawModelId: hostedRaw,
          label: 'GLM 5.2',
          supportsVision: false,
          supportedThinkingLevels: [],
        },
      ]);
      const onModelChange = jest.fn();
      render(
        createElement(ModelPicker, {
          currentModel: CODEX_NON_GATEWAY,
          onModelChange,
          allowCopilot: true,
          allowOpenCode: true,
          browserLayout: 'harnesses',
        }),
      );
      openPicker();
      act(() => visible(`chat-model-harness-tab-${harness}`)?.click());
      expect(visible(`chat-model-option-${hostedId}`)).toBeNull();
      expect(visible(`chat-model-option-${GLM}`)).not.toBeNull();
      expect(visible(`chat-model-option-${GLM}`)?.textContent).not.toContain(
        'AI Credits',
      );
      act(() => visible(`chat-model-option-${GLM}`)?.click());
      expect(onModelChange).toHaveBeenLastCalledWith(hostedId);
    });
    it('keeps an established account chat on its route after duplicate removal', () => {
      const onModelChange = jest.fn();
      render(
        createElement(ModelPicker, {
          currentModel: id,
          lockedHarness: harness,
          lockedProvider: harness,
          onModelChange,
          allowCopilot: true,
          allowOpenCode: true,
          browserLayout: 'harnesses',
        }),
      );
      openPicker();
      const row = visible(`chat-model-option-${CODEX_NON_GATEWAY}`);
      expect(row?.getAttribute('aria-checked')).toBe('true');
      expect(row?.getAttribute('aria-disabled')).not.toBe('true');
      act(() => row?.click());
      expect(onModelChange).toHaveBeenLastCalledWith(id);
    });
  },
);
