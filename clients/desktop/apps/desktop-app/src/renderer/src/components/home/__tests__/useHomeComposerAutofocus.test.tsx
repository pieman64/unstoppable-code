/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createChatEditor, focusEditor } from '@canopy/ui-rich/editor';
import type * as UiRichEditorModule from '@canopy/ui-rich/editor';
import { useNavigationStore } from '@/stores/navigationStore';
import { useHomeComposerAutofocus } from '../useHomeComposerAutofocus';

jest.mock('@canopy/ui-rich/editor', () => {
  const actual = jest.requireActual<typeof UiRichEditorModule>(
    '@canopy/ui-rich/editor',
  );
  return { ...actual, focusEditor: jest.fn() };
});

const mockedFocusEditor = jest.mocked(focusEditor);
const editor = createChatEditor();

function Harness({ enabled }: { enabled: boolean }): JSX.Element {
  useHomeComposerAutofocus(editor, enabled);
  return <div />;
}

describe('useHomeComposerAutofocus', () => {
  let container: HTMLDivElement;
  let root: Root;
  let requestAnimationFrameSpy: jest.SpyInstance;
  let cancelAnimationFrameSpy: jest.SpyInstance;
  let documentHasFocusSpy: jest.SpyInstance;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    useNavigationStore.setState({
      activePage: 'overview',
      homeComposerFocusRequest: 0,
    });
    mockedFocusEditor.mockReset();
    documentHasFocusSpy = jest
      .spyOn(document, 'hasFocus')
      .mockReturnValue(true);
    requestAnimationFrameSpy = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    cancelAnimationFrameSpy = jest
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
    documentHasFocusSpy.mockRestore();
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });

  it('focuses on mount and on every Home navigation request', () => {
    act(() => root.render(<Harness enabled />));
    expect(mockedFocusEditor).toHaveBeenCalledTimes(1);
    expect(mockedFocusEditor).toHaveBeenLastCalledWith(editor);

    act(() => useNavigationStore.getState().navigate('home'));
    act(() => useNavigationStore.getState().navigate('home'));

    expect(mockedFocusEditor).toHaveBeenCalledTimes(3);
  });

  it('does not focus an embedded or disabled Home composer', () => {
    act(() => root.render(<Harness enabled={false} />));
    act(() => useNavigationStore.getState().navigate('home'));

    expect(mockedFocusEditor).not.toHaveBeenCalled();
  });

  it('waits for the app window to receive focus during startup', () => {
    documentHasFocusSpy.mockReturnValue(false);

    act(() => root.render(<Harness enabled />));
    expect(mockedFocusEditor).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(mockedFocusEditor).toHaveBeenCalledTimes(1);
    expect(mockedFocusEditor).toHaveBeenCalledWith(editor);
  });

  it('preserves a control focused before the app window receives focus', () => {
    documentHasFocusSpy.mockReturnValue(false);
    const button = document.createElement('button');
    document.body.appendChild(button);

    try {
      act(() => root.render(<Harness enabled />));
      button.focus();

      act(() => {
        window.dispatchEvent(new Event('focus'));
      });

      expect(document.activeElement).toBe(button);
      expect(mockedFocusEditor).not.toHaveBeenCalled();
    } finally {
      button.remove();
    }
  });

  it('does not steal focus when a modal opens before the scheduled frame', () => {
    let scheduledFocus: FrameRequestCallback | undefined;
    requestAnimationFrameSpy.mockImplementation(
      (callback: FrameRequestCallback) => {
        scheduledFocus = callback;
        return 1;
      },
    );

    act(() => root.render(<Harness enabled />));
    expect(scheduledFocus).toBeDefined();

    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    const modalRect = modal.getBoundingClientRect();
    const modalRects: DOMRectList = Object.assign([modalRect], {
      item: (index: number): DOMRect | null => (index === 0 ? modalRect : null),
    });
    jest.spyOn(modal, 'getClientRects').mockReturnValue(modalRects);
    document.body.appendChild(modal);
    try {
      act(() => scheduledFocus?.(0));
      expect(mockedFocusEditor).not.toHaveBeenCalled();
    } finally {
      modal.remove();
    }
  });

  it('allows focus when only a hidden modal remains mounted', () => {
    let scheduledFocus: FrameRequestCallback | undefined;
    requestAnimationFrameSpy.mockImplementation(
      (callback: FrameRequestCallback) => {
        scheduledFocus = callback;
        return 1;
      },
    );

    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    modal.hidden = true;
    document.body.appendChild(modal);
    try {
      act(() => root.render(<Harness enabled />));
      act(() => scheduledFocus?.(0));
      expect(mockedFocusEditor).toHaveBeenCalledWith(editor);
    } finally {
      modal.remove();
    }
  });
});
