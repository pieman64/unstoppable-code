/**
 * @jest-environment jsdom
 */
import { succeedClientOperation } from '@canopy/desktop-instrumentation/client';
import {
  DEFAULT_MODEL,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import {
  HOME_COMPOSER_KEY,
  markSuggestedPromptInserted,
  resetChatMessageSendTelemetryForTests,
} from '@/lib/chatMessageSendTelemetry';
import { trackHomeChatSend } from '../homeSendTelemetry';

jest.mock('@canopy/desktop-instrumentation/client', () => ({
  startClientOperation: jest.fn(),
  succeedClientOperation: jest.fn(),
}));
jest.mock('@/lib/chatAttachments', () => ({
  importChatAttachments: jest.fn(),
}));
jest.mock('@/lib/automationToasts', () => ({
  showAutomationCreatedToast: jest.fn(),
}));
jest.mock('@/lib/panels/persistence-bridge', () => ({
  ensureWorktreePanelLayout: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/lib/chatPluginEditing', () => ({
  applyNewChatPluginSelections: jest.fn(() => Promise.resolve()),
}));

const mockSucceed = jest.mocked(succeedClientOperation);

function lastContext(): Record<string, unknown> | undefined {
  return mockSucceed.mock.calls.at(-1)?.[1]?.context;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetChatMessageSendTelemetryForTests();
  useHomeComposerStore.setState({
    workspaceId: 'ws',
    model: DEFAULT_MODEL,
    modelSelectionMode: undefined,
    executionHarness: undefined,
    text: 'Send this draft',
    attachments: [],
    scheduledSendDraft: null,
    planMode: false,
  });
});

it('reports a Home send with the model and provider the draft will run', () => {
  trackHomeChatSend();

  expect(mockSucceed).toHaveBeenCalledTimes(1);
  expect(mockSucceed.mock.calls[0]?.[0]).toBe('canopy.chat_message_send');
  expect(lastContext()).toMatchObject({
    chat_surface: 'home',
    is_suggested_prompt: false,
    provider: 'claude',
    model: DEFAULT_MODEL,
  });
  expect(typeof lastContext()?.is_ai_credits_billed).toBe('boolean');
});

it.each([
  [false, 'default'],
  [true, 'plan'],
] as const)(
  'reports a workspace draft with plan mode %s as composer_mode=%s',
  (planMode, composerMode) => {
    useHomeComposerStore.setState({ planMode });

    trackHomeChatSend();

    expect(lastContext()).toMatchObject({ composer_mode: composerMode });
  },
);

it('reports default for a cowork send even when the plan toggle stayed on', () => {
  useHomeComposerStore.setState({ planMode: true });
  trackHomeChatSend();
  expect(lastContext()).toMatchObject({ composer_mode: 'plan' });

  // Switching to a cowork target leaves the stored toggle on, but plan mode is
  // unavailable there.
  useHomeComposerStore.setState({ workspaceId: STANDALONE_CHAT_PROJECT_ID });
  trackHomeChatSend();
  expect(lastContext()).toMatchObject({ composer_mode: 'default' });
});

it('reports default when no workspace is selected', () => {
  useHomeComposerStore.setState({ workspaceId: null, planMode: true });

  trackHomeChatSend();

  expect(lastContext()).toMatchObject({ composer_mode: 'default' });
});

it('reports Auto when the draft routes its model per turn', () => {
  useHomeComposerStore.setState({ modelSelectionMode: 'auto' });

  trackHomeChatSend();

  expect(lastContext()).toMatchObject({ model: 'auto' });
  expect(lastContext()).not.toHaveProperty('provider');
});

it('reports a suggested prompt inserted into the Home composer', () => {
  markSuggestedPromptInserted(HOME_COMPOSER_KEY);

  trackHomeChatSend();

  expect(lastContext()).toMatchObject({ is_suggested_prompt: true });
});

it.each(['', '  \n '])(
  'ignores a blank draft (%j) without consuming suggestion state',
  (text) => {
    useHomeComposerStore.setState({ text });
    markSuggestedPromptInserted(HOME_COMPOSER_KEY);
    trackHomeChatSend();
    expect(mockSucceed).not.toHaveBeenCalled();

    useHomeComposerStore.setState({ text: 'Real first message' });
    trackHomeChatSend();
    expect(lastContext()).toMatchObject({
      is_suggested_prompt: true,
    });
  },
);

it('ignores scheduled drafts without emitting an immediate send', () => {
  useHomeComposerStore.setState({
    scheduledSendDraft: { runAt: '2100-01-01T12:00:00Z' },
  });
  trackHomeChatSend();
  expect(mockSucceed).not.toHaveBeenCalled();

  useHomeComposerStore.setState({ scheduledSendDraft: null });
  trackHomeChatSend();
  expect(lastContext()).not.toHaveProperty('is_first_message');
});

it('counts an attachment-only immediate message', () => {
  useHomeComposerStore.setState({
    text: ' ',
    attachments: [
      { filename: 'context.txt', absolutePath: '/tmp/context.txt' },
    ],
  });
  trackHomeChatSend();
  expect(mockSucceed).toHaveBeenCalledTimes(1);
  expect(lastContext()).not.toHaveProperty('is_first_message');
});
