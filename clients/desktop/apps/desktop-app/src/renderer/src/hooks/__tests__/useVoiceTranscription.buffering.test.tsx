/**
 * @jest-environment jsdom
 */
jest.mock('slate-react', () => ({
  withReact: <T,>(editor: T): T => editor,
  ReactEditor: { focus: (): void => {}, isFocused: (): boolean => false },
}));

import { act, createElement, useEffect, useRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor, Node, Transforms } from 'slate';
import { createChatEditor } from '@canopy/ui-rich/editor';
import type { ChatEditor } from '@canopy/ui-rich/types';
import {
  useVoiceTranscription,
  type UseVoiceTranscriptionResult,
} from '../useVoiceTranscription';
import type {
  VoiceProviderHandlers,
  VoiceTranscriptionProvider,
} from '@/lib/voice/voice-types';
import type { VoiceTarget } from '@/lib/voice/voice-target';
import { createSlateVoiceTarget } from '@/lib/voice/insert-into-slate';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

/** Records every take's handlers so tests can replay provider events. */
class ScriptedProvider implements VoiceTranscriptionProvider {
  readonly name = 'scripted';
  takes: VoiceProviderHandlers[] = [];
  startResult: () => Promise<void> = () => Promise.resolve();
  stopResult: () => Promise<void> = () => Promise.resolve();
  onCancel: () => void = () => {};
  cancelCount = 0;

  get handlers(): VoiceProviderHandlers {
    const latest = this.takes[this.takes.length - 1];
    if (!latest) throw new Error('no take started');
    return latest;
  }

  isSupported(): Promise<boolean> {
    return Promise.resolve(true);
  }

  start(handlers: VoiceProviderHandlers): Promise<void> {
    this.takes.push(handlers);
    return this.startResult();
  }

  stop(): Promise<void> {
    return this.stopResult();
  }

  cancel(): Promise<void> {
    this.cancelCount += 1;
    this.onCancel();
    return Promise.resolve();
  }
}

function makeEditor(text = ''): ChatEditor {
  const editor = createChatEditor();
  editor.children = [{ type: 'paragraph', children: [{ text }] }];
  const point = Editor.end(editor, []);
  editor.selection = { anchor: point, focus: point };
  return editor;
}

function textOf(editor: ChatEditor): string {
  return editor.children.map((node) => Node.string(node)).join('\n');
}

interface HarnessProps {
  provider: VoiceTranscriptionProvider;
  target: VoiceTarget | null;
  destinationKey?: string | null;
  onFinalCommitted?: (text: string) => void;
  /** Mirrors the chat and home composers' send-after-stop contract. */
  onDeferredSend?: () => void;
  armSendRef?: { current: (() => Promise<void>) | null };
  onRender: (voice: UseVoiceTranscriptionResult) => void;
}

function Harness({
  provider,
  target,
  destinationKey,
  onFinalCommitted,
  onDeferredSend,
  armSendRef,
  onRender,
}: HarnessProps): JSX.Element {
  const options = { target, destinationKey, provider, onFinalCommitted };
  const voice = useVoiceTranscription(options);
  const sendAfterVoiceRef = useRef(false);
  if (armSendRef) {
    armSendRef.current = (): Promise<void> => {
      sendAfterVoiceRef.current = true;
      return voice.stop();
    };
  }
  useEffect(() => {
    if (!sendAfterVoiceRef.current) return;
    if (voice.state === 'error') {
      sendAfterVoiceRef.current = false;
      return;
    }
    if (voice.state !== 'idle') return;
    sendAfterVoiceRef.current = false;
    onDeferredSend?.();
  }, [voice.state, onDeferredSend]);
  useEffect(() => {
    onRender(voice);
  });
  return createElement('div');
}

interface Mounted {
  latest: () => UseVoiceTranscriptionResult;
  rerender: (next: Partial<Omit<HarnessProps, 'onRender'>>) => void;
  unmount: () => void;
}

function mount(props: Omit<HarnessProps, 'onRender'>): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  let current: UseVoiceTranscriptionResult | null = null;
  let currentProps = props;
  const render = (): void => {
    root?.render(
      createElement(Harness, {
        ...currentProps,
        onRender: (voice): void => {
          current = voice;
        },
      }),
    );
  };
  act(() => {
    root = createRoot(container);
    render();
  });
  return {
    latest: (): UseVoiceTranscriptionResult => {
      if (!current) throw new Error('harness did not render');
      return current;
    },
    rerender: (next): void => {
      currentProps = { ...currentProps, ...next };
      act(() => render());
    },
    unmount: (): void => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

function emit(fn: () => void): void {
  act(() => fn());
}

describe('useVoiceTranscription buffers dictation until the take ends', () => {
  let harness: Mounted | null = null;
  afterEach(() => {
    harness?.unmount();
    harness = null;
  });

  it('keeps interim transcripts out of the composer while listening', async () => {
    const provider = new ScriptedProvider();
    const editor = makeEditor('Draft');
    harness = mount({ provider, target: createSlateVoiceTarget(editor) });

    await act(async () => harness?.latest().start());
    emit(() => provider.handlers.onInterim('hello'));
    emit(() => provider.handlers.onInterim('hello world'));
    emit(() => provider.handlers.onInterim('hello world, how are you'));

    expect(textOf(editor)).toBe('Draft');
    expect(harness.latest().state).toBe('listening');
  });

  it('keeps every keyboard edit made during recording and inserts once at the cursor', async () => {
    const provider = new ScriptedProvider();
    const editor = makeEditor('Draft note');
    const committed = jest.fn();
    harness = mount({
      provider,
      target: createSlateVoiceTarget(editor),
      onFinalCommitted: committed,
    });

    await act(async () => harness?.latest().start());
    emit(() => provider.handlers.onInterim('hello'));

    // A lasting insertion, a deletion of a different original character, and
    // a cursor move, all while the take is still recording.
    Transforms.insertText(editor, '!', { at: { path: [0, 0], offset: 5 } });
    Transforms.delete(editor, {
      at: { path: [0, 0], offset: 0 },
      distance: 1,
      unit: 'character',
    });
    Transforms.select(editor, { path: [0, 0], offset: 5 });
    emit(() => provider.handlers.onInterim('hello world'));

    expect(textOf(editor)).toBe('raft! note');

    emit(() => provider.handlers.onFinal('Hello world.'));

    expect(textOf(editor)).toBe('raft! Hello world. note');
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledWith('Hello world.');
    expect(harness.latest().state).toBe('idle');
  });

  it('inserts the buffered transcript when the take stops without a final', async () => {
    const provider = new ScriptedProvider();
    const editor = makeEditor();
    const seen: string[] = [];
    const committed = jest.fn(() => seen.push(textOf(editor)));
    harness = mount({
      provider,
      target: createSlateVoiceTarget(editor),
      onFinalCommitted: committed,
    });

    await act(async () => harness?.latest().start());
    emit(() => provider.handlers.onInterim('stop early'));
    emit(() => provider.handlers.onStopped());

    expect(textOf(editor)).toBe('stop early');
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledWith('stop early');
    expect(seen).toEqual(['stop early']);
    expect(harness.latest().state).toBe('idle');
  });

  it('inserts the buffered transcript before surfacing a dictation error', async () => {
    const provider = new ScriptedProvider();
    const editor = makeEditor();
    const seen: string[] = [];
    const committed = jest.fn(() => seen.push(textOf(editor)));
    harness = mount({
      provider,
      target: createSlateVoiceTarget(editor),
      onFinalCommitted: committed,
    });

    await act(async () => harness?.latest().start());
    emit(() => provider.handlers.onInterim('words so far'));
    emit(() => provider.handlers.onError('Speech recognition failed'));

    expect(textOf(editor)).toBe('words so far');
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledWith('words so far');
    expect(seen).toEqual(['words so far']);
    expect(harness.latest().state).toBe('error');
    expect(harness.latest().error).toBe('Speech recognition failed');
  });

  it('keeps the interim transcript when the final arrives blank', async () => {
    const provider = new ScriptedProvider();
    const editor = makeEditor();
    const committed = jest.fn();
    harness = mount({
      provider,
      target: createSlateVoiceTarget(editor),
      onFinalCommitted: committed,
    });

    await act(async () => harness?.latest().start());
    emit(() => provider.handlers.onInterim('keep me'));
    emit(() => provider.handlers.onFinal('   '));

    expect(textOf(editor)).toBe('keep me');
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledWith('keep me');
    expect(harness.latest().state).toBe('idle');
  });
});

describe('useVoiceTranscription take lifecycle', () => {
  let harness: Mounted | null = null;
  afterEach(() => {
    harness?.unmount();
    harness = null;
  });

  async function started(
    editorText = '',
    extra: Partial<Omit<HarnessProps, 'onRender'>> = {},
  ): Promise<{
    provider: ScriptedProvider;
    editor: ChatEditor;
    target: VoiceTarget;
    committed: jest.Mock;
    h: Mounted;
  }> {
    const provider = new ScriptedProvider();
    const editor = makeEditor(editorText);
    const target = createSlateVoiceTarget(editor);
    const committed = jest.fn();
    const h = mount({
      provider,
      target,
      onFinalCommitted: committed,
      ...extra,
    });
    harness = h;
    await act(async () => h.latest().start());
    return { provider, editor, target, committed, h };
  }

  it('lets a nonblank final supersede interim snapshots without concatenating', async () => {
    const { provider, editor, committed } = await started();
    emit(() => provider.handlers.onInterim('list'));
    emit(() => provider.handlers.onInterim('list the files'));
    emit(() => provider.handlers.onFinal('List the files in src.'));
    expect(textOf(editor)).toBe('List the files in src.');
    expect(committed).toHaveBeenCalledWith('List the files in src.');
  });

  it('keeps the last usable snapshot when a blank interim follows it', async () => {
    const { provider, editor, committed } = await started();
    emit(() => provider.handlers.onInterim('first snapshot'));
    emit(() => provider.handlers.onInterim(''));
    emit(() => provider.handlers.onInterim('  '));
    emit(() => provider.handlers.onStopped());
    expect(textOf(editor)).toBe('first snapshot');
    expect(committed).toHaveBeenCalledTimes(1);
  });

  it('inserts nothing, and no stray space, for an empty take', async () => {
    const { provider, editor, committed, h } = await started('Draft');
    emit(() => provider.handlers.onFinal(''));
    expect(textOf(editor)).toBe('Draft');
    expect(committed).not.toHaveBeenCalled();
    expect(h.latest().state).toBe('idle');
  });

  it.each([
    ['final then stopped', ['final', 'stopped']],
    ['final then error', ['final', 'error']],
    ['stopped then late final', ['stopped', 'final']],
    ['error then final', ['error', 'final']],
    ['error then stopped', ['error', 'stopped']],
  ] as const)('commits at most once: %s', async (_label, sequence) => {
    const { provider, editor, committed, h } = await started();
    emit(() => provider.handlers.onInterim('heard'));
    for (const event of sequence) {
      emit(() => {
        if (event === 'final') provider.handlers.onFinal('heard more');
        if (event === 'stopped') provider.handlers.onStopped();
        if (event === 'error') provider.handlers.onError('boom');
      });
    }
    expect(committed).toHaveBeenCalledTimes(1);
    const expected = sequence[0] === 'final' ? 'heard more' : 'heard';
    expect(textOf(editor)).toBe(expected);
    expect(h.latest().state).toBe(sequence[0] === 'error' ? 'error' : 'idle');
  });

  it('ignores interim and level events after the take ends', async () => {
    const { provider, h } = await started();
    emit(() => provider.handlers.onFinal('done'));
    emit(() => provider.handlers.onInterim('late'));
    provider.handlers.onLevel?.(0.9);
    expect(h.latest().state).toBe('idle');
    expect(h.latest().readLevel()).toBe(0);
  });

  it('commits once when the target triggers a reentrant terminal event', async () => {
    const provider = new ScriptedProvider();
    const editor = makeEditor();
    const inner = createSlateVoiceTarget(editor);
    const committed = jest.fn();
    const target: VoiceTarget = {
      commitFinal: (text): void => {
        inner.commitFinal(text);
        provider.handlers.onFinal('again');
        provider.handlers.onStopped();
      },
    };
    harness = mount({ provider, target, onFinalCommitted: committed });
    await act(async () => harness?.latest().start());
    emit(() => provider.handlers.onFinal('once'));
    expect(textOf(editor)).toBe('once');
    expect(committed).toHaveBeenCalledTimes(1);
  });

  it('reports an insertion failure without acknowledging a commit', async () => {
    const provider = new ScriptedProvider();
    const committed = jest.fn();
    const sent = jest.fn();
    const armSendRef: { current: (() => Promise<void>) | null } = {
      current: null,
    };
    const target: VoiceTarget = {
      commitFinal: (): void => {
        throw new Error('editor detached');
      },
    };
    harness = mount({
      provider,
      target,
      onFinalCommitted: committed,
      onDeferredSend: sent,
      armSendRef,
    });
    await act(async () => harness?.latest().start());
    emit(() => provider.handlers.onInterim('words'));
    await act(async () => armSendRef.current?.());
    emit(() => provider.handlers.onFinal('words'));
    expect(committed).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(harness.latest().state).toBe('error');
    expect(harness.latest().error).toBe("Couldn't insert the dictated text");
  });

  it('discards the take on cancel, including callbacks fired while cancelling', async () => {
    const { provider, editor, committed, h } = await started('Draft');
    emit(() => provider.handlers.onInterim('throw this away'));
    const handlers = provider.handlers;
    provider.onCancel = (): void => {
      handlers.onFinal('throw this away');
      handlers.onStopped();
    };
    await act(async () => h.latest().cancel());
    emit(() => handlers.onFinal('late'));
    emit(() => handlers.onError('late error'));
    expect(textOf(editor)).toBe('Draft');
    expect(committed).not.toHaveBeenCalled();
    expect(h.latest().state).toBe('idle');
    expect(h.latest().error).toBeNull();
  });

  it('only lets the current take affect text or state', async () => {
    const { provider, editor, committed, h } = await started();
    const first = provider.handlers;
    emit(() => first.onFinal('one'));
    await act(async () => h.latest().start());
    const second = provider.handlers;
    expect(second).not.toBe(first);
    emit(() => {
      first.onInterim('stale');
      first.onFinal('stale');
      first.onStopped();
      first.onError('stale error');
      first.onLevel?.(0.9);
    });
    expect(h.latest().state).toBe('listening');
    expect(h.latest().readLevel()).toBe(0);
    emit(() => second.onFinal('two'));
    expect(textOf(editor)).toBe('one two');
    expect(committed.mock.calls).toEqual([['one'], ['two']]);
  });

  it('completes without inserting when stopped while connecting with no text', async () => {
    const provider = new ScriptedProvider();
    provider.startResult = (): Promise<void> => new Promise(() => {});
    const editor = makeEditor('Draft');
    const committed = jest.fn();
    harness = mount({
      provider,
      target: createSlateVoiceTarget(editor),
      onFinalCommitted: committed,
    });
    act(() => {
      void harness?.latest().start();
    });
    expect(harness.latest().state).toBe('connecting');
    await act(async () => harness?.latest().stop());
    expect(harness.latest().state).toBe('idle');
    expect(textOf(editor)).toBe('Draft');
    expect(committed).not.toHaveBeenCalled();
    expect(provider.cancelCount).toBe(1);
  });

  it('keeps text heard before an early stop', async () => {
    const { provider, editor, committed, h } = await started();
    emit(() => provider.handlers.onInterim('quick note'));
    await act(async () => h.latest().stop());
    // The provider ends the take after stop; nothing is inserted before then.
    expect(textOf(editor)).toBe('');
    emit(() => provider.handlers.onStopped());
    expect(textOf(editor)).toBe('quick note');
    expect(committed).toHaveBeenCalledTimes(1);
  });

  it('preserves buffered text when stop rejects', async () => {
    const { provider, editor, committed, h } = await started();
    provider.stopResult = (): Promise<void> =>
      Promise.reject(new Error('helper went away'));
    emit(() => provider.handlers.onInterim('saved words'));
    await act(async () => h.latest().stop());
    expect(textOf(editor)).toBe('saved words');
    expect(committed).toHaveBeenCalledWith('saved words');
    expect(h.latest().state).toBe('error');
  });

  it('preserves buffered text when start rejects after interim text', async () => {
    const provider = new ScriptedProvider();
    provider.startResult = (): Promise<void> => {
      provider.handlers.onInterim('before failure');
      return Promise.reject(new Error('helper crashed'));
    };
    const editor = makeEditor();
    const committed = jest.fn();
    harness = mount({
      provider,
      target: createSlateVoiceTarget(editor),
      onFinalCommitted: committed,
    });
    await act(async () => harness?.latest().start());
    expect(textOf(editor)).toBe('before failure');
    expect(committed).toHaveBeenCalledTimes(1);
    expect(harness.latest().state).toBe('error');
    expect(harness.latest().error).toBe('helper crashed');
  });

  it('rejects late callbacks after unmount', async () => {
    const { provider, editor, committed, h } = await started();
    emit(() => provider.handlers.onInterim('unmounted'));
    const handlers = provider.handlers;
    h.unmount();
    harness = null;
    handlers.onFinal('unmounted');
    handlers.onStopped();
    expect(textOf(editor)).toBe('');
    expect(committed).not.toHaveBeenCalled();
    expect(provider.cancelCount).toBe(1);
  });

  it('never inserts an old take into a newly selected composer', async () => {
    const { provider, editor, committed, h } = await started('first');
    emit(() => provider.handlers.onInterim('for the first composer'));
    const other = makeEditor('second');
    h.rerender({ target: createSlateVoiceTarget(other) });
    emit(() => provider.handlers.onFinal('for the first composer'));
    expect(textOf(editor)).toBe('first');
    expect(textOf(other)).toBe('second');
    expect(committed).not.toHaveBeenCalled();
    expect(h.latest().state).toBe('idle');
  });

  it('discards a take permanently when its destination changes away and back', async () => {
    const { provider, editor, target, committed, h } = await started('first');
    const old = provider.handlers;
    emit(() => old.onInterim('discard me'));
    provider.onCancel = (): void => {
      old.onFinal('discard me');
      old.onError('cancelled destination');
    };
    h.rerender({ target: createSlateVoiceTarget(makeEditor('second')) });
    expect(provider.cancelCount).toBeGreaterThan(0);
    expect(h.latest().state).toBe('idle');
    h.rerender({ target });
    emit(() => {
      old.onInterim('late');
      old.onLevel?.(0.9);
      old.onFinal('discard me');
      old.onStopped();
      old.onError('late error');
    });
    expect(textOf(editor)).toBe('first');
    expect(committed).not.toHaveBeenCalled();
    expect(h.latest().state).toBe('idle');
    expect(h.latest().readLevel()).toBe(0);
  });

  it('does not acknowledge a missing destination', async () => {
    const { provider, committed, h } = await started('', { target: null });
    emit(() => provider.handlers.onFinal('no editor'));
    expect(committed).not.toHaveBeenCalled();
    expect(h.latest().state).toBe('idle');
  });

  it('discards a changed chat destination even when its editor target is reused', async () => {
    const { provider, editor, committed, h } = await started('Draft', {
      destinationKey: 'first-chat',
    });
    const old = provider.handlers;
    emit(() => old.onInterim('for the first chat'));
    h.rerender({ destinationKey: 'second-chat' });
    expect(h.latest().state).toBe('idle');
    expect(provider.cancelCount).toBe(1);
    h.rerender({ destinationKey: 'first-chat' });
    emit(() => {
      old.onFinal('for the first chat');
      old.onInterim('late');
      old.onStopped();
      old.onError('late error');
      old.onLevel?.(0.9);
    });
    expect(textOf(editor)).toBe('Draft');
    expect(committed).not.toHaveBeenCalled();
    expect(h.latest().state).toBe('idle');
    expect(h.latest().readLevel()).toBe(0);
  });

  it('keeps an insertion failure when stopped through a connecting render', async () => {
    const provider = new ScriptedProvider();
    provider.startResult = (): Promise<void> => new Promise(() => {});
    const committed = jest.fn();
    harness = mount({
      provider,
      target: {
        commitFinal: (): void => {
          throw new Error('detached');
        },
      },
      onFinalCommitted: committed,
    });
    act(() => {
      void harness?.latest().start();
    });
    const connecting = harness.latest();
    await act(async () => {
      provider.handlers.onInterim('already heard');
      await connecting.stop();
    });
    expect(committed).not.toHaveBeenCalled();
    expect(harness.latest().state).toBe('error');
    expect(harness.latest().error).toBe("Couldn't insert the dictated text");
  });

  it('keeps text received just before stop through a connecting render', async () => {
    const provider = new ScriptedProvider();
    provider.startResult = (): Promise<void> => new Promise(() => {});
    const editor = makeEditor('Draft');
    const committed = jest.fn();
    harness = mount({
      provider,
      target: createSlateVoiceTarget(editor),
      onFinalCommitted: committed,
    });
    act(() => {
      void harness?.latest().start();
    });
    const connecting = harness.latest();
    await act(async () => {
      provider.handlers.onInterim('quick words');
      await connecting.stop();
    });
    expect(textOf(editor)).toBe('Draft quick words');
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledWith('quick words');
    expect(harness.latest().state).toBe('idle');
  });
});

describe('send after stop', () => {
  let harness: Mounted | null = null;
  afterEach(() => {
    harness?.unmount();
    harness = null;
  });

  async function arm(): Promise<{
    provider: ScriptedProvider;
    editor: ChatEditor;
    sentText: string[];
    h: Mounted;
    armSendRef: { current: (() => Promise<void>) | null };
  }> {
    const provider = new ScriptedProvider();
    const editor = makeEditor('Fix');
    const sentText: string[] = [];
    const armSendRef: { current: (() => Promise<void>) | null } = {
      current: null,
    };
    const h = mount({
      provider,
      target: createSlateVoiceTarget(editor),
      onDeferredSend: () => sentText.push(textOf(editor)),
      armSendRef,
    });
    harness = h;
    await act(async () => h.latest().start());
    emit(() => provider.handlers.onInterim('the bug'));
    Transforms.insertText(editor, ' it');
    await act(async () => armSendRef.current?.());
    return { provider, editor, sentText, h, armSendRef };
  }

  it('sends keyboard edits and the authoritative final exactly once', async () => {
    const { provider, sentText } = await arm();
    expect(sentText).toEqual([]);
    emit(() => provider.handlers.onFinal('the login bug'));
    emit(() => provider.handlers.onStopped());
    expect(sentText).toEqual(['Fix it the login bug']);
  });

  it('sends keyboard edits and the stopped fallback exactly once', async () => {
    const { provider, sentText } = await arm();
    emit(() => provider.handlers.onStopped());
    expect(sentText).toEqual(['Fix it the bug']);
  });

  it('does not send after a failed take, nor arm a send for the next take', async () => {
    const { provider, editor, sentText, h } = await arm();
    emit(() => provider.handlers.onError('Speech recognition failed'));
    expect(h.latest().state).toBe('error');
    expect(textOf(editor)).toBe('Fix it the bug');
    expect(sentText).toEqual([]);
    await act(async () => h.latest().start());
    emit(() => provider.handlers.onFinal('next take'));
    expect(sentText).toEqual([]);
  });
});
