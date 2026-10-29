/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor, Node } from 'slate';
import { createChatEditor } from '@canopy/ui-rich/editor';
import type { VoiceProviderHandlers } from '@/lib/voice/voice-types';
import { ConfigurationComposerVoiceControl } from '../ConfigurationComposerVoiceControl';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
let supported = true;
const sessions: VoiceProviderHandlers[] = [];
const cancel = jest.fn(async (): Promise<void> => {});
jest.mock('@/hooks/useVoiceDictationGate', () => ({
  useVoiceDictationGate: (): {
    voiceSupported: boolean;
    voiceEnabledPref: boolean;
  } => ({
    voiceSupported: supported,
    voiceEnabledPref: true,
  }),
}));
jest.mock('@/lib/voice/apple-speech-bridge', () => ({
  AppleSpeechBridgeProvider: class {
    start(handlers: VoiceProviderHandlers): Promise<void> {
      sessions.push(handlers);
      return Promise.resolve();
    }
    stop(): Promise<void> {
      return Promise.resolve();
    }
    cancel(): Promise<void> {
      return cancel();
    }
  },
}));

describe('configuration composer dictation', () => {
  it('inserts text and ignores delayed results after the destination changes', async () => {
    const editor = createChatEditor();
    editor.children = [{ type: 'paragraph', children: [{ text: '' }] }];
    const point = Editor.end(editor, []);
    editor.selection = { anchor: point, focus: point };
    const committed = jest.fn();
    const pending = jest.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    sessions.length = 0;
    cancel.mockClear();
    supported = true;
    try {
      await act(async () => {
        await Promise.resolve();
        root.render(
          <ConfigurationComposerVoiceControl
            editor={editor}
            scopeKey="first"
            disabled={false}
            onCommitted={committed}
            onPendingChange={pending}
          />,
        );
      });
      await act(async () => {
        await Promise.resolve();
        host
          .querySelector<HTMLButtonElement>(
            '[data-testid="voice-input-button"]',
          )
          ?.click();
      });
      expect(sessions).toHaveLength(1);
      expect(pending).toHaveBeenLastCalledWith(true);
      await act(async () => {
        await Promise.resolve();
        sessions[0].onInterim('Review the');
      });
      // Interim text stays out of the editor while the take records.
      expect(Node.string(editor)).toBe('');
      expect(committed).not.toHaveBeenCalled();
      expect(pending).toHaveBeenLastCalledWith(true);
      await act(async () => {
        await Promise.resolve();
        sessions[0].onFinal('Review the plan');
      });
      expect(Node.string(editor)).toBe('Review the plan');
      expect(committed).toHaveBeenCalledTimes(1);
      await act(async () => {
        await Promise.resolve();
        host
          .querySelector<HTMLButtonElement>(
            '[data-testid="voice-input-button"]',
          )
          ?.click();
      });
      expect(sessions).toHaveLength(2);
      await act(async () => {
        await Promise.resolve();
        root.render(
          <ConfigurationComposerVoiceControl
            editor={editor}
            scopeKey="second"
            disabled={false}
            onCommitted={committed}
            onPendingChange={pending}
          />,
        );
      });
      expect(cancel).toHaveBeenCalled();
      await act(async () => {
        await Promise.resolve();
        sessions[1].onFinal('stale result');
      });
      expect(Node.string(editor)).toBe('Review the plan');
      expect(committed).toHaveBeenCalledTimes(1);
      expect(pending).toHaveBeenLastCalledWith(false);
      supported = false;
      await act(async () => {
        await Promise.resolve();
        root.render(
          <ConfigurationComposerVoiceControl
            editor={editor}
            scopeKey="second"
            disabled={false}
            onCommitted={committed}
          />,
        );
      });
      expect(
        host.querySelector('[data-testid="voice-input-button"]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
