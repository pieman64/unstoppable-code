/**
 * @jest-environment jsdom
 */
import { act, useRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useChatFileDrop, type ChatFileDropState } from '../useChatFileDrop';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface ComposerProps {
  readonly id: string;
  readonly ownBoxOnly?: boolean;
  readonly enabled?: boolean;
  readonly onDropFiles: (files: File[]) => void;
  readonly onState: (state: ChatFileDropState) => void;
}

function Composer({
  id,
  ownBoxOnly = false,
  enabled = true,
  onDropFiles,
  onState,
}: ComposerProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  onState(
    useChatFileDrop({ boxRef, rootRef, enabled, ownBoxOnly, onDropFiles }),
  );
  return (
    <div ref={rootRef} data-testid={`${id}-root`}>
      <div ref={boxRef} data-testid={`${id}-box`} />
    </div>
  );
}

function dragEvent(
  type: 'dragenter' | 'dragleave' | 'dragover' | 'drop',
  { files = [], types = ['Files'] }: { files?: File[]; types?: string[] } = {},
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  // jsdom has no DataTransfer; the hook reads only these fields.
  Object.defineProperty(event, 'dataTransfer', {
    value: { types, files, dropEffect: 'none' },
  });
  return event;
}

function byTestId(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}

describe('useChatFileDrop', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function dispatch(target: HTMLElement, event: Event): Event {
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it('takes a file drop anywhere on the marked chat area', () => {
    const onDropFiles = jest.fn();
    let state: ChatFileDropState = { dragging: false, zone: null };
    act(() => {
      root.render(
        <div data-chat-drop-zone data-testid="chat">
          <div data-testid="transcript" />
          <Composer
            id="composer"
            onDropFiles={onDropFiles}
            onState={(next): void => {
              state = next;
            }}
          />
        </div>,
      );
    });
    const chat = byTestId(container, 'chat');
    const transcript = byTestId(container, 'transcript');
    expect(state.zone).toBe(chat);

    dispatch(transcript, dragEvent('dragenter'));
    expect(state.dragging).toBe(true);

    const file = new File(['log'], 'upload-test.log');
    const drop = dispatch(transcript, dragEvent('drop', { files: [file] }));
    expect(drop.defaultPrevented).toBe(true);
    expect(onDropFiles).toHaveBeenCalledWith([file]);
    expect(state.dragging).toBe(false);
  });

  it('stays on while the drag crosses the area’s children', () => {
    let state: ChatFileDropState = { dragging: false, zone: null };
    act(() => {
      root.render(
        <div data-chat-drop-zone data-testid="chat">
          <div data-testid="transcript" />
          <Composer
            id="composer"
            onDropFiles={jest.fn()}
            onState={(next): void => {
              state = next;
            }}
          />
        </div>,
      );
    });
    const transcript = byTestId(container, 'transcript');
    const box = byTestId(container, 'composer-box');

    dispatch(transcript, dragEvent('dragenter'));
    dispatch(box, dragEvent('dragenter'));
    dispatch(transcript, dragEvent('dragleave'));
    expect(state.dragging).toBe(true);
    dispatch(box, dragEvent('dragleave'));
    expect(state.dragging).toBe(false);
  });

  it('leaves drags without files to their own handlers', () => {
    const onDropFiles = jest.fn();
    let state: ChatFileDropState = { dragging: false, zone: null };
    act(() => {
      root.render(
        <div data-chat-drop-zone data-testid="chat">
          <Composer
            id="composer"
            onDropFiles={onDropFiles}
            onState={(next): void => {
              state = next;
            }}
          />
        </div>,
      );
    });
    const chat = byTestId(container, 'chat');
    const panelDrag = { types: ['application/x-canopy-panel-tab'] };

    dispatch(chat, dragEvent('dragenter', panelDrag));
    expect(state.dragging).toBe(false);
    const drop = dispatch(chat, dragEvent('drop', panelDrag));
    expect(drop.defaultPrevented).toBe(false);
    expect(onDropFiles).not.toHaveBeenCalled();
  });

  it('falls back to the composer when the host marks no chat area', () => {
    let state: ChatFileDropState = { dragging: false, zone: null };
    act(() => {
      root.render(
        <Composer
          id="composer"
          onDropFiles={jest.fn()}
          onState={(next): void => {
            state = next;
          }}
        />,
      );
    });
    expect(state.zone).toBe(byTestId(container, 'composer-root'));
  });

  it('gives a drop on the queued-message editor to that editor only', () => {
    const onChatDrop = jest.fn();
    const onQueuedDrop = jest.fn();
    let queuedState: ChatFileDropState = { dragging: false, zone: null };
    let chatState: ChatFileDropState = { dragging: false, zone: null };
    act(() => {
      root.render(
        <div data-chat-drop-zone>
          <Composer
            id="queued"
            ownBoxOnly
            onDropFiles={onQueuedDrop}
            onState={(next): void => {
              queuedState = next;
            }}
          />
          <Composer
            id="composer"
            onDropFiles={onChatDrop}
            onState={(next): void => {
              chatState = next;
            }}
          />
        </div>,
      );
    });
    // The chat dims; the queued editor draws nothing of its own.
    expect(queuedState.zone).toBeNull();

    const queuedBox = byTestId(container, 'queued-box');
    dispatch(queuedBox, dragEvent('dragenter'));
    expect(chatState.dragging).toBe(true);

    const file = new File(['png'], 'ci-failure.png');
    dispatch(queuedBox, dragEvent('drop', { files: [file] }));
    expect(onQueuedDrop).toHaveBeenCalledWith([file]);
    expect(onChatDrop).not.toHaveBeenCalled();
    // No dragleave follows a drop, and the editor keeps the drop from
    // reaching the chat's own drop listener: the chat must still clear its
    // dim, or the overlay stays up after the drop.
    expect(chatState.dragging).toBe(false);
    expect(queuedState.dragging).toBe(false);
  });

  it('takes no drops while disabled', () => {
    const onDropFiles = jest.fn();
    act(() => {
      root.render(
        <div data-chat-drop-zone data-testid="chat">
          <Composer
            id="composer"
            enabled={false}
            onDropFiles={onDropFiles}
            onState={jest.fn()}
          />
        </div>,
      );
    });
    const file = new File(['log'], 'upload-test.log');
    const drop = dispatch(
      byTestId(container, 'chat'),
      dragEvent('drop', { files: [file] }),
    );
    expect(drop.defaultPrevented).toBe(false);
    expect(onDropFiles).not.toHaveBeenCalled();
  });
});
