/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useComposerActions } from '../useComposerActions';
import { requestComposerAction } from '@/lib/composerShortcutRequests';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('composer action routing', () => {
  it('keeps its subscription while using the latest action callback', () => {
    const root = createRoot(document.createElement('div'));
    const subscribe = jest.spyOn(document, 'addEventListener');
    const first = jest.fn();
    const next = jest.fn();
    const scope = { scope: 'home' as const, composerId: 'stable' };
    function Harness({ action }: { action: () => void }): null {
      useComposerActions(scope, { model: action }, true);
      return null;
    }
    try {
      act(() => root.render(<Harness action={first} />));
      const count = subscribe.mock.calls.length;
      act(() => root.render(<Harness action={next} />));
      expect(subscribe.mock.calls).toHaveLength(count);
      requestComposerAction(scope, 'model');
      expect(next).toHaveBeenCalledTimes(1);
      expect(first).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      subscribe.mockRestore();
    }
  });
  it('routes Home actions to the originating composer instance', () => {
    const root = createRoot(document.createElement('div'));
    const first = jest.fn();
    const second = jest.fn();
    const firstScope = { scope: 'home' as const, composerId: 'first' };
    const secondScope = { scope: 'home' as const, composerId: 'second' };
    function Harness(): null {
      useComposerActions(firstScope, { model: first }, true);
      useComposerActions(secondScope, { model: second }, true);
      return null;
    }
    try {
      act(() => root.render(<Harness />));
      requestComposerAction(firstScope, 'model');
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
  it('targets one chat and ignores disabled or unsupported controls', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const first = jest.fn();
    const second = jest.fn();
    const scope = {
      scope: 'chat' as const,
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'first',
    };
    function Harness({ enabled }: { enabled: boolean }): null {
      useComposerActions(scope, { model: first }, enabled);
      useComposerActions(
        { ...scope, chatId: 'second' },
        { model: second },
        true,
      );
      return null;
    }
    try {
      act(() => root.render(<Harness enabled />));
      expect(requestComposerAction(scope, 'model')).toBe(true);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
      expect(requestComposerAction(scope, 'attach')).toBe(false);
      act(() => root.render(<Harness enabled={false} />));
      expect(requestComposerAction(scope, 'model')).toBe(false);
      expect(first).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });
});
