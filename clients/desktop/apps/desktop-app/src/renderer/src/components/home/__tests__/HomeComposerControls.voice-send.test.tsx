/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createChatEditor } from '@canopy/ui-rich/editor';
import { Editor, Node, Transforms } from 'slate';
import type { VoiceProviderHandlers } from '@/lib/voice/voice-types';
import { HomeComposerControls } from '../HomeComposerControls';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useChatStore } from '@/stores/chatStore';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The real hint store hydrates when the Home composer mounts.
const preferences = { planModeHint: { version: 1, generation: 0 } };
Object.defineProperty(window, 'api', {
  value: {
    loadPreferences: jest.fn().mockResolvedValue(preferences),
    savePreferences: jest.fn().mockResolvedValue(preferences),
    onPreferencesSynced: jest.fn(() => (): void => undefined),
  },
});

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
const takes: VoiceProviderHandlers[] = [];
jest.mock('@/lib/voice/apple-speech-bridge', () => ({
  AppleSpeechBridgeProvider: class {
    start(handlers: VoiceProviderHandlers): Promise<void> {
      takes.push(handlers);
      return Promise.resolve();
    }
    stop(): Promise<void> {
      return Promise.resolve();
    }
    cancel(): Promise<void> {
      return Promise.resolve();
    }
  },
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

const originalHome = useHomeComposerStore.getState();
const originalChat = useChatStore.getState();

it.each(['final', 'stopped', 'error'] as const)(
  'Home sends only the completed %s take with keyboard edits',
  async (terminal) => {
    takes.length = 0;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const editor = createChatEditor();
    editor.children = [
      { type: 'paragraph', children: [{ text: 'Draft note' }] },
    ];
    const point = Editor.end(editor, []);
    editor.selection = { anchor: point, focus: point };
    const sent: string[] = [];
    const changed = jest.fn();
    useHomeComposerStore.setState({
      ...originalHome,
      workspaceId: 'voice-test',
      model: 'opus[1m]',
      approvalMode: 'ask',
      loadDiscovery: jest.fn().mockResolvedValue(undefined),
    });
    useChatStore.setState({
      approvalDefaultsCache: { 'voice-test': 'ask' },
    });

    const click = async (testId: string): Promise<void> => {
      const button = document.querySelector(`[data-testid="${testId}"]`);
      if (!(button instanceof HTMLButtonElement))
        throw new Error(`Missing ${testId}`);
      await act(async () => {
        await Promise.resolve();
        button.click();
      });
    };
    try {
      await act(async () => {
        await Promise.resolve();
        root.render(
          <HomeComposerControls
            editor={editor}
            disabled={false}
            shortcutEnabled
            onSend={() => sent.push(Node.string(editor))}
            onEditorExternallyChanged={changed}
            commands={[]}
            commandsRefreshing={false}
            isCodex={false}
            onSelectCommand={jest.fn()}
          />,
        );
      });
      await click('voice-input-button');
      const first = takes[0];
      act(() => first.onInterim('heard words'));
      expect(Node.string(editor)).toBe('Draft note');
      Transforms.insertText(editor, '!');
      Transforms.delete(editor, {
        at: { path: [0, 0], offset: 0 },
        distance: 1,
        unit: 'character',
      });
      Transforms.select(editor, Editor.end(editor, []));
      await click('voice-recording-send');
      expect(sent).toEqual([]);
      act(() => {
        if (terminal === 'final') first.onFinal('Final words.');
        if (terminal === 'stopped') first.onStopped();
        if (terminal === 'error') first.onError('Speech recognition failed');
      });
      expect(Node.string(editor)).toBe(
        `raft note! ${terminal === 'final' ? 'Final words.' : 'heard words'}`,
      );
      expect(changed).toHaveBeenCalledTimes(1);
      if (terminal === 'error') {
        expect(sent).toEqual([]);
        await click('voice-error-modal-close');
        await click('voice-input-button');
        act(() => takes[1].onFinal('later take'));
        expect(Node.string(editor)).toBe('raft note! heard words later take');
        expect(sent).toEqual([]);
      } else {
        expect(sent).toEqual([Node.string(editor)]);
        act(() => {
          first.onStopped();
          first.onFinal('late');
        });
        expect(sent).toHaveLength(1);
      }
    } finally {
      act(() => root.unmount());
      container.remove();
      useHomeComposerStore.setState(originalHome, true);
      useChatStore.setState(originalChat, true);
    }
  },
);
