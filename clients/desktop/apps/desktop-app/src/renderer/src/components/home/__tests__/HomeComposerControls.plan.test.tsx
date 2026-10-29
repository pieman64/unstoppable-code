/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toCopilotModelId } from '@canopy/desktop-shared/lib/copilot-models';
import { createChatEditor } from '@canopy/ui-rich/editor';
import { HomeComposerControls } from '../HomeComposerControls';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useChatStore } from '@/stores/chatStore';
import { useOnboardingSuggestionSurfaces } from '@/stores/onboardingSuggestionSurfacesStore';
import { requestComposerAction } from '@/lib/composerShortcutRequests';
import { useVoiceTranscription } from '@/hooks/useVoiceTranscription';
import type { UseVoiceTranscriptionResult } from '@/hooks/useVoiceTranscription';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Keep the real Home store, provider resolver, action subscription, + menu,
// and shared chip. Replace unrelated service hooks and setting pickers.
jest.mock('@/hooks/useProviderAvailability', () => ({
  useProviderAvailability: (): object => ({}),
}));
jest.mock('@/hooks/useMarketplaceList', () => ({
  useMarketplaceList: (): object => ({ cache: null }),
}));
jest.mock('@/hooks/useLinearStatus', () => ({
  useLinearAvailability: (): object => ({ available: false }),
}));
jest.mock('@/hooks/useAutoModelRouting', () => ({
  useAutoModelRoutingAvailability: (): object => ({ offered: false }),
}));
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => undefined,
}));
jest.mock('@/hooks/useContextualCodexSpeedControl', () => ({
  useContextualCodexSpeedControl: (): object => ({ states: [] }),
}));
jest.mock('@/hooks/useCodexSpeedDowngrade', () => ({
  useCodexSpeedDowngrade: ({ speed }: { speed: string }): string => speed,
}));
jest.mock('@/hooks/useComposerShortcutRequests', () => ({
  useComposerShortcutRequests: (): number => 0,
}));
jest.mock('@/hooks/useHoldToDictate', () => ({
  useHoldToDictate: (): object => ({}),
}));
jest.mock('@/hooks/useVoiceDictationGate', () => ({
  useVoiceDictationGate: (): object => ({
    voiceSupported: true,
    voiceEnabledPref: true,
  }),
}));
jest.mock('@/hooks/useVoiceTranscription', () => ({
  useVoiceTranscription: jest.fn(),
}));
jest.mock('../useHomeEffectiveModelSettings', () => ({
  useHomeEffectiveModelSettings: (
    _workspace: unknown,
    model: string,
  ): object => ({
    model: model ?? 'opus[1m]',
    thinkingLevel: 'high',
    supportedThinkingLevels: [],
  }),
}));
jest.mock('@/components/chat/ModelPicker', () => ({
  ModelPicker: (): null => null,
}));
jest.mock('@/components/chat/ApprovalModePicker', () => ({
  ApprovalModePicker: (): null => null,
}));

let container: HTMLDivElement;
let root: Root;
let voice: UseVoiceTranscriptionResult;
const originalHome = useHomeComposerStore.getState();
const originalChat = useChatStore.getState();
const originalOnboarding = useOnboardingSuggestionSurfaces.getState();

function render(disabled = false): void {
  act(() => {
    root.render(
      <HomeComposerControls
        editor={createChatEditor()}
        disabled={disabled}
        shortcutEnabled
        onSend={jest.fn()}
        onEditorExternallyChanged={jest.fn()}
        commands={[]}
        commandsRefreshing={false}
        isCodex={false}
        onSelectCommand={jest.fn()}
      />,
    );
  });
}

function chip(): HTMLButtonElement {
  const button = container.querySelector(
    '[data-testid="home-plan-mode-inline-button"]',
  );
  if (!(button instanceof HTMLButtonElement))
    throw new Error('Missing Plan tile');
  return button;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  voice = {
    state: 'idle',
    error: null,
    errorGuidance: null,
    dismissError: jest.fn(),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
    readLevel: (): number => 0,
    listeningSince: null,
  };
  jest
    .mocked(useVoiceTranscription)
    .mockImplementation((): UseVoiceTranscriptionResult => voice);
  useHomeComposerStore.setState({
    ...originalHome,
    workspaceId: 'plan-test',
    model: 'opus[1m]',
    approvalMode: 'default',
    planMode: false,
    loadDiscovery: jest.fn().mockResolvedValue(undefined),
  });
  useChatStore.setState({ approvalDefaultsCache: { 'plan-test': 'default' } });
  useOnboardingSuggestionSurfaces.setState({ planModeHighlight: false });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useHomeComposerStore.setState(originalHome, true);
  useChatStore.setState(originalChat, true);
  useOnboardingSuggestionSurfaces.setState(originalOnboarding, true);
});

it('the plan composer action enables and disables the same store state and tile', () => {
  render();
  expect(
    container.querySelector('[data-testid="home-plan-mode-inline-button"]'),
  ).toBeNull();
  act(() =>
    expect(requestComposerAction({ scope: 'home' }, 'plan')).toBe(true),
  );
  expect(useHomeComposerStore.getState().planMode).toBe(true);
  expect(chip().getAttribute('aria-pressed')).toBe('true');
  act(() => {
    requestComposerAction({ scope: 'home' }, 'plan');
  });
  expect(useHomeComposerStore.getState().planMode).toBe(false);
  expect(
    container.querySelector('[data-testid="home-plan-mode-inline-button"]'),
  ).toBeNull();
});

it('disabled Home ignores tile clicks and composer actions without clearing Plan', () => {
  useHomeComposerStore.setState({ planMode: true });
  render(true);
  expect(chip().disabled).toBe(true);
  const plus = container.querySelector(
    '[data-testid="home-composer-plus-button"]',
  );
  expect(plus).toBeInstanceOf(HTMLButtonElement);
  expect(plus?.hasAttribute('disabled')).toBe(true);
  act(() => chip().click());
  act(() =>
    expect(requestComposerAction({ scope: 'home' }, 'plan')).toBe(false),
  );
  expect(useHomeComposerStore.getState().planMode).toBe(true);
  expect(chip().getAttribute('aria-pressed')).toBe('true');
});

it('provider changes update the tile and menu together while retaining Plan', () => {
  useHomeComposerStore.setState({ planMode: true });
  render();
  for (const model of [
    'cursor-default',
    toCopilotModelId('gpt-5.5'),
    'opus[1m]',
  ]) {
    act(() => useHomeComposerStore.getState().setModel(model));
    const readOnly = model !== 'opus[1m]';
    expect(chip().textContent).toContain(readOnly ? 'Read only' : 'Plan');
    expect(chip().getAttribute('aria-label')).toBe(
      readOnly ? 'Disable read-only mode' : 'Disable plan mode',
    );
    const plus = container.querySelector(
      '[data-testid="home-composer-plus-button"]',
    );
    if (!(plus instanceof HTMLButtonElement)) throw new Error('Missing +');
    act(() => plus.click());
    const row = document.querySelector('[data-testid="home-plan-mode-button"]');
    expect(row?.textContent).toContain(
      readOnly ? 'Read-only mode' : 'Plan mode',
    );
    expect(row?.getAttribute('aria-pressed')).toBe('true');
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(useHomeComposerStore.getState().planMode).toBe(true);
  }
});

it('dictation replaces the toolbar and restores its active tile for the same draft', () => {
  useHomeComposerStore.setState({ planMode: true });
  render();
  expect(chip().textContent).toContain('Plan');
  for (const state of ['connecting', 'listening'] as const) {
    voice = { ...voice, state };
    render();
    expect(
      container.querySelector('[data-testid="home-composer-toolbar"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="voice-recording-row"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="home-plan-mode-inline-button"]'),
    ).toBeNull();
    expect(useHomeComposerStore.getState().planMode).toBe(true);
  }
  voice = { ...voice, state: 'idle' };
  render();
  expect(chip().getAttribute('aria-pressed')).toBe('true');
  expect(
    container.querySelector('[data-testid="voice-recording-row"]'),
  ).toBeNull();
});

it('mounting an existing active draft renders its tile without another toggle', () => {
  useHomeComposerStore.setState({ planMode: true });
  render();
  act(() => root.unmount());
  root = createRoot(container);
  render();
  expect(chip().textContent).toContain('Plan');
  expect(useHomeComposerStore.getState().planMode).toBe(true);
});
