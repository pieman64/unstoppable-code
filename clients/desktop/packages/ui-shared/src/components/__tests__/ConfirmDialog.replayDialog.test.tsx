/**
 * @jest-environment jsdom
 */
// CAN-3119 (F2): `ConfirmDialog` is what the desktop `ChatInput` portals for
// the cross-harness continue confirmation. `DialogModal` records its card, so
// the dialog content stays recorded. The error carries no conversation,
// output, file, or secret content. This pins the content inside the recorded
// card, outside any block.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { ConfirmDialog } from '../ConfirmDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MODEL = 'Custom Model 7';
const MESSAGE = 'This chat about the Acme migration moves to a new chat.';
const ERROR = 'Could not summarize the Acme migration chat.';

/**
 * Asserts `content` sits in a recorded `DialogModal` card and returns the
 * card. Only `DialogModal`'s overlay carries
 * `data-canopy-overlay-root="modal"`, which pins the card to that component.
 * `closest` is inclusive: neither the card nor its ancestors carry a block.
 */
function expectInRecordedDialogCard(content: Element): HTMLElement {
  const card = content.closest<HTMLElement>('[role="dialog"]');
  if (card === null) throw new Error('Content is not inside a dialog card');
  expect(card.getAttribute('aria-modal')).toBe('true');
  expect(card.parentElement?.getAttribute('data-canopy-overlay-root')).toBe(
    'modal',
  );
  expect(card.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  return card;
}

describe('ConfirmDialog session replay', () => {
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

  it('records the message and error inside the recorded DialogModal card', () => {
    // Mirrors the props `ChatInput` passes for the continue confirmation.
    act(() => {
      root.render(
        <ConfirmDialog
          dataTestId="continue-on-provider-dialog"
          confirmTestId="continue-on-provider-confirm"
          title={`Start a new chat with ${MODEL}?`}
          message={
            <span className="flex flex-col gap-2">
              <span data-testid="continue-message">{MESSAGE}</span>
            </span>
          }
          confirmLabel="Start new chat"
          busyLabel="Setting up…"
          errorMessage={ERROR}
          onConfirm={(): void => undefined}
          onCancel={(): void => undefined}
        />,
      );
    });

    const message = document.querySelector('[data-testid="continue-message"]');
    if (message === null) throw new Error('Message not rendered');
    expect(container.contains(message)).toBe(false);
    const card = expectInRecordedDialogCard(message);
    expect(card.getAttribute('data-testid')).toBe(
      'continue-on-provider-dialog',
    );
    expect(message.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(card.querySelector('h2')?.textContent).toBe(
      `Start a new chat with ${MODEL}?`,
    );

    const error = document.querySelector(
      '[data-testid="confirm-dialog-error"]',
    );
    if (error === null) throw new Error('Error not rendered');
    expect(error.textContent).toBe(ERROR);
    expect(expectInRecordedDialogCard(error)).toBe(card);
    expect(error.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();

    // The buttons stay recorded.
    const confirm = card.querySelector(
      '[data-testid="continue-on-provider-confirm"]',
    );
    expect(confirm?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
