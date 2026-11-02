/** @jest-environment jsdom */
// Test-only source harness, matching the adjacent voice source tests.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';
// eslint-disable-next-line no-restricted-imports
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import {
  createPlanModeHintStore,
  type PlanModeHintStore,
} from '@canopy/app-state';
import { act, useState, type ComponentProps, type JSX } from 'react';
import type * as ReactModule from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PlanModeHint, type PlanModeSuggestion } from '@canopy/ui-app';
import { toCopilotModelId } from '@canopy/desktop-shared/lib/copilot-models';
import { createChatEditor } from '@canopy/ui-rich/editor';
import { HomeComposerControls } from '../HomeComposerControls';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useChatStore } from '@/stores/chatStore';

import { requestComposerAction } from '@/lib/composerShortcutRequests';
import { useVoiceTranscription } from '@/hooks/useVoiceTranscription';
import type { UseVoiceTranscriptionResult } from '@/hooks/useVoiceTranscription';
import type { ModelPicker } from '@/components/chat/ModelPicker';
import { importChatAttachments } from '@/lib/chatAttachments';
import { useWorkspaceItemsStore } from '@/stores/workspaceItemsStore';
import { registerCoworkWorkspaceIds } from '@/lib/cowork-registry';
import type { TryItAccountState } from '@/hooks/useCanopyCloudConnected';
import { ATTACHMENT_SIGN_IN_COPY } from '@canopy/ui-app/guest-files';

type ModelPickerProps = ComponentProps<typeof ModelPicker>;

let mockAccountStatus: 'loading' | 'guest' | 'signed-in' = 'signed-in';
const mockRequestConnect = jest.fn();
jest.mock('@/hooks/useCanopyCloudConnected', () => ({
  useTryItAccount: (): TryItAccountState => ({
    status: mockAccountStatus,
    accountId: mockAccountStatus === 'signed-in' ? 'account:1' : null,
  }),
}));
jest.mock('@/stores/cloudConnectGateStore', () => ({
  useCloudConnectGateStore: {
    getState: (): { requestConnect: typeof mockRequestConnect } => ({
      requestConnect: mockRequestConnect,
    }),
  },
}));
jest.mock('@/lib/chatAttachments', () => ({
  importChatAttachments: jest.fn(),
}));

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
const mockPendingModelSelections: Array<() => void> = [];
let mockModelPickerProps: ModelPickerProps | undefined;
jest.mock('@/components/chat/ModelPicker', () => ({
  ModelPicker: (props: ModelPickerProps): null => {
    mockModelPickerProps = props;
    const React = jest.requireActual<typeof ReactModule>('react');
    const origin = React.useRef(props.onModelChange);
    React.useEffect(() => {
      // Stand in for the real modal's mounted-attempt guard while a save is
      // deferred. The host must actually retire it when the draft is replaced.
      let mounted = true;
      mockPendingModelSelections.push(() => {
        if (mounted) origin.current('haiku');
      });
      return (): void => {
        mounted = false;
      };
    }, []);
    return null;
  },
}));
jest.mock('@/components/chat/ApprovalModePicker', () => ({
  ApprovalModePicker: (): null => null,
}));

let container: HTMLDivElement;
let root: Root;
let voice: UseVoiceTranscriptionResult;
const originalHome = useHomeComposerStore.getState();
const originalChat = useChatStore.getState();

/** Draws the hint the composer hands up, as `HomeSurface`'s drawer does. */
function HomeHost({
  disabled,
  hintDraftRevision,
}: {
  disabled: boolean;
  hintDraftRevision: number;
}): JSX.Element {
  const [hint, setHint] = useState<PlanModeSuggestion | null>(null);
  return (
    <>
      {hint !== null ? <PlanModeHint hint={hint} /> : null}
      <HomeComposerControls
        hintDraftRevision={hintDraftRevision}
        editor={createChatEditor()}
        disabled={disabled}
        shortcutEnabled
        onSend={jest.fn()}
        onEditorExternallyChanged={jest.fn()}
        commands={[]}
        commandsRefreshing={false}
        isCodex={false}
        onSelectCommand={jest.fn()}
        onPlanModeHintChange={setHint}
      />
    </>
  );
}

function render(disabled = false, hintDraftRevision = 0): void {
  act(() => {
    root.render(
      <HomeHost disabled={disabled} hintDraftRevision={hintDraftRevision} />,
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

const mockHintStore = createPlanModeHintStore({
  load: () =>
    Promise.resolve({
      record: { version: 1, generation: 0 },
      persisted: true,
    }),
  save: (record) => Promise.resolve(record),
});
jest.mock('@/lib/planModeHint', () => ({
  getPlanModeHintStore: (): PlanModeHintStore => mockHintStore,
}));

beforeEach(() => {
  mockPendingModelSelections.length = 0;
  mockModelPickerProps = undefined;
  mockAccountStatus = 'signed-in';
  mockRequestConnect.mockClear();
  jest.mocked(importChatAttachments).mockReset().mockResolvedValue([]);
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
    approvalMode: 'ask',
    planMode: false,
    loadDiscovery: jest.fn().mockResolvedValue(undefined),
  });
  useChatStore.setState({ approvalDefaultsCache: { 'plan-test': 'ask' } });
});

it('passes an unset Home billing preference through to the picker', () => {
  useChatStore.setState({ modelDefaults: null });
  render();
  expect(mockModelPickerProps?.billing?.value).toBeUndefined();
});

it('CAN-5211 retires a pending model recovery when Home starts another draft', () => {
  render();
  const finishOldRecovery = mockPendingModelSelections[0];
  if (!finishOldRecovery) throw new Error('Missing originating picker');
  act(() => {
    useHomeComposerStore.getState().clearSubmittedDraft();
    useHomeComposerStore.getState().setText('The next draft stays unchanged');
    useHomeComposerStore.getState().setModel('sonnet');
  });
  act(() => finishOldRecovery());
  expect(useHomeComposerStore.getState().model).toBe('sonnet');
  expect(useHomeComposerStore.getState().text).toBe(
    'The next draft stays unchanged',
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useHomeComposerStore.setState(originalHome, true);
  useChatStore.setState(originalChat, true);
});

it.each(['loading', 'guest'] as const)(
  'intercepts the Home file shortcut while %s before opening a picker',
  (status) => {
    mockAccountStatus = status;
    render();
    act(() =>
      expect(requestComposerAction({ scope: 'home' }, 'attach')).toBe(true),
    );
    if (status === 'guest') {
      expect(mockRequestConnect).toHaveBeenCalledWith(
        {
          title: ATTACHMENT_SIGN_IN_COPY.title,
          description: ATTACHMENT_SIGN_IN_COPY.body,
          subtitle: null,
        },
        expect.any(Function),
      );
    } else {
      expect(mockRequestConnect).not.toHaveBeenCalled();
    }
    expect(importChatAttachments).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().attachments).toEqual([]);
  },
);

it('drops old picker results after account eligibility changes away and back', async () => {
  let resolvePicker:
    | ((attachments: Awaited<ReturnType<typeof importChatAttachments>>) => void)
    | undefined;
  jest.mocked(importChatAttachments).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePicker = resolve;
      }),
  );
  render();
  act(() => {
    requestComposerAction({ scope: 'home' }, 'attach');
  });
  expect(importChatAttachments).toHaveBeenCalledTimes(1);
  mockAccountStatus = 'guest';
  render();
  mockAccountStatus = 'signed-in';
  render();
  await act(async () => {
    resolvePicker?.([
      { filename: 'old.txt', absolutePath: '/attachments/old.txt' },
    ]);
    await Promise.resolve();
  });
  expect(useHomeComposerStore.getState().attachments).toEqual([]);
  expect(useHomeComposerStore.getState().pendingAttachmentImportIds).toEqual(
    [],
  );
});

it.each(['plan-test', 'cowork-files-test'])(
  'does not refresh attachments after a pending %s picker loses account access',
  async (projectId) => {
    registerCoworkWorkspaceIds(['cowork-files-test']);
    useHomeComposerStore.setState({ workspaceId: projectId });
    jest.mocked(importChatAttachments).mockImplementation(
      jest.requireActual<{
        importChatAttachments: typeof importChatAttachments;
      }>('@/lib/chatAttachments').importChatAttachments,
    );
    let finish: ((value: { attachments: [] }) => void) | undefined;
    const importFiles = jest.fn(
      () =>
        new Promise<{ attachments: [] }>((resolve) => {
          finish = resolve;
        }),
    );
    const listAttachments = jest.fn().mockResolvedValue([]);
    const previousApi = window.api;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...previousApi,
        importWorktreeAttachments: importFiles,
        workspaceItems: { importAttachments: importFiles, listAttachments },
      },
    });
    const previousItems = useWorkspaceItemsStore.getState();
    try {
      render();
      act(() => {
        requestComposerAction({ scope: 'home' }, 'attach');
      });
      expect(importFiles).toHaveBeenCalledTimes(1);
      mockAccountStatus = 'guest';
      render();
      await act(async () => {
        finish?.({ attachments: [] });
        await Promise.resolve();
      });
      expect(listAttachments).not.toHaveBeenCalled();
      expect(useHomeComposerStore.getState().attachments).toEqual([]);
      expect(
        useHomeComposerStore.getState().pendingAttachmentImportIds,
      ).toEqual([]);
    } finally {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: previousApi,
      });
      useWorkspaceItemsStore.setState(previousItems, true);
    }
  },
);

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

it('does not present an ignored hint again when the same draft changes provider', async () => {
  jest.useFakeTimers();
  const rect = new DOMRect(0, 0, 320, 100);
  const rects = Object.assign([rect], {
    item: (index: number): DOMRect | null => (index === 0 ? rect : null),
  });
  const visibility = jest
    .spyOn(HTMLElement.prototype, 'getClientRects')
    .mockReturnValue(rects);
  try {
    await mockHintStore.getState().hydrate();
    mockHintStore.setState({
      status: 'ready',
      record: { version: 1, generation: 0 },
      suppressed: false,
    });
    useHomeComposerStore.setState({
      text: [
        'Please do the following:',
        '- add the migration for the new column',
        '- update the API handler to read the column',
        '- write tests for the handler and the migration',
        'Keep the changes small and make sure the existing tests keep passing.',
      ].join('\n'),
    });
    render();
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(
      container.querySelector('[data-testid="plan-mode-suggestion"]'),
    ).not.toBeNull();
    act(() => useHomeComposerStore.getState().setModel('cursor-default'));
    expect(
      container.querySelector('[data-testid="plan-mode-suggestion"]'),
    ).toBeNull();
    act(() => useHomeComposerStore.getState().setModel('opus[1m]'));
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(
      container.querySelector('[data-testid="plan-mode-suggestion"]'),
    ).toBeNull();
  } finally {
    visibility.mockRestore();
    jest.useRealTimers();
  }
});

it('Home text replacement preserves the generation owning a pending attachment import', () => {
  const token = useHomeComposerStore.getState().beginAttachmentImport();
  // Exercise the production text-only handler against the real draft store.
  // Isolate its editor collaborators rather than mounting unrelated Home hosts.
  const source = readFileSync(
    path.join(__dirname, '../HomeSurface.tsx'),
    'utf8',
  );
  const handlerSource = source.match(
    / {2}function handleInsertCommandText\(text: string\): void \{[\s\S]*?\n {2}\}/,
  )?.[0];
  if (!handlerSource)
    throw new Error('Home text replacement handler not found');
  runInNewContext(
    transpile(`${handlerSource}\nhandleInsertCommandText('Replacement task');`),
    {
      useHomeComposerStore,
      setHintDraftRevision: jest.fn(),
      editor: createChatEditor(),
      resetEditor: jest.fn(),
      Transforms: { insertText: jest.fn() },
      handleEditorExternallyChanged: () =>
        useHomeComposerStore
          .getState()
          .setDraft({ text: 'Replacement task', fileReferences: [] }),
    },
  );
  const current = useHomeComposerStore.getState();
  expect(current.draftGeneration).toBe(token.draftGeneration);
  expect(current.pendingAttachmentImportIds).toContain(token.id);
});

it('a replacement hint revision starts a new presentation without changing attachment ownership', async () => {
  jest.useFakeTimers();
  const rect = new DOMRect(0, 0, 320, 100);
  const visibility = jest
    .spyOn(HTMLElement.prototype, 'getClientRects')
    .mockReturnValue(Object.assign([rect], { item: () => rect }));
  try {
    await mockHintStore.getState().hydrate();
    mockHintStore.setState({
      status: 'ready',
      record: { version: 1, generation: 0 },
      suppressed: false,
    });
    useHomeComposerStore.setState({
      text: [
        'Please do the following:',
        '- add the migration for the new column',
        '- update the API handler to read the column',
        '- write tests for the handler and the migration',
        'Keep the changes small and make sure the existing tests keep passing.',
      ].join('\n'),
    });
    const generation = useHomeComposerStore.getState().draftGeneration;
    render();
    act(() => jest.advanceTimersByTime(600));
    expect(
      container.querySelector('[data-testid="plan-mode-suggestion"]'),
    ).not.toBeNull();
    act(() =>
      useHomeComposerStore
        .getState()
        .setDraft({ text: 'Short task', fileReferences: [] }),
    );
    expect(
      container.querySelector('[data-testid="plan-mode-suggestion"]'),
    ).toBeNull();
    act(() =>
      useHomeComposerStore.getState().setDraft({
        text:
          'word '.repeat(80) + '\nFirst do this. Then do that. Finally finish.',
        fileReferences: [],
      }),
    );
    render(false, 1);
    act(() => jest.advanceTimersByTime(600));
    expect(
      container.querySelector('[data-testid="plan-mode-suggestion"]'),
    ).not.toBeNull();
    expect(useHomeComposerStore.getState().draftGeneration).toBe(generation);
  } finally {
    visibility.mockRestore();
    jest.useRealTimers();
  }
});
