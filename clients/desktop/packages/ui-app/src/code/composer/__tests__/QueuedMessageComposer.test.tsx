/** @jest-environment jsdom */

import {
  act,
  forwardRef,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  useImperativeHandle,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  QueuedMessageComposer,
  type QueuedMessageEditControls,
} from '../QueuedMessageComposer';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

// The real editor runs the host's onKeyDown first; the stub keeps that.
jest.mock('@canopy/ui-rich/editor', () => ({
  ComposerEditor: forwardRef(function MockComposerEditor(
    props: {
      dataTestId?: string;
      onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
    },
    ref,
  ): JSX.Element {
    useImperativeHandle(ref, () => ({
      focus: (): void => undefined,
      serialize: (): { text: string } => ({ text: '' }),
    }));
    return (
      <div
        data-testid={props.dataTestId}
        tabIndex={0}
        onKeyDown={props.onKeyDown}
      />
    );
  }),
}));

function pressEscape(container: HTMLElement, isComposing: boolean): void {
  const input = container.querySelector<HTMLElement>(
    '[data-testid="queued-message-edit-input"]',
  );
  act(() => {
    input?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        isComposing,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe('QueuedMessageComposer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let edit: QueuedMessageEditControls;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    edit = {
      entryId: 'q1',
      initialText: 'original',
      allowEmpty: false,
      onSave: jest.fn(),
      onCancel: jest.fn(),
    };
    act(() => root.render(<QueuedMessageComposer edit={edit} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('cancels on Escape', () => {
    pressEscape(container, false);
    expect(edit.onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps the edit when Escape dismisses an IME candidate', () => {
    pressEscape(container, true);
    expect(edit.onCancel).not.toHaveBeenCalled();
  });
});
