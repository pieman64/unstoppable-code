/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import {
  CHAT_VISUAL_TEST_IDS,
  type ChatVisualHost,
  type ChatVisualOwner,
} from '../chat-visual-host';
import { ChatVisualDialog } from '../ChatVisualDialog';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PRIVATE_SOURCE = '<h1>Acme renewal forecast</h1>';
const owner: ChatVisualOwner = {
  messageId: 'message-1',
  toolUseId: 'tool-1',
  reference: {
    version: 1,
    visualId: 'vis_00000000-0000-0000-0000-000000000001',
    artifactId: `sha256-v1-${'0'.repeat(64)}`,
    sha256: '0'.repeat(64),
    byteLength: PRIVATE_SOURCE.length,
    mediaType: 'text/html',
    title: 'Acme renewal forecast',
    maxHeight: 400,
  },
};
const host: ChatVisualHost = {
  read: jest.fn(),
  openLink: jest.fn(),
};

let root: Root | null = null;

function openSource(): void {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <ChatVisualDialog
        owner={owner}
        document={PRIVATE_SOURCE}
        host={host}
        theme={{ appearance: 'light', variables: {} }}
        initialTab="source"
        onClose={jest.fn()}
      />,
    ),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

// The dialog is portalled out of the transcript and the Chat visuals panel,
// so their session replay blocks do not reach it.
describe('the visual dialog in session replay', () => {
  it('blocks the source text', () => {
    openSource();
    const source = document.querySelector(
      `[data-testid="${CHAT_VISUAL_TEST_IDS.sourceView}"]`,
    );
    expect(source?.textContent).toBe(PRIVATE_SOURCE);
    expect(source?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
  });

  it('masks the visual title and keeps the dialog recorded', () => {
    openSource();
    const dialog = document.querySelector(
      `[data-testid="${CHAT_VISUAL_TEST_IDS.dialog}"]`,
    );
    const heading = dialog?.querySelector('h2');
    expect(heading?.textContent).toBe('Acme renewal forecast');
    const masked = heading?.querySelector(`.${REPLAY_MASK_CLASS}`);
    expect(masked?.textContent).toBe('Acme renewal forecast');
    expect(dialog?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(heading?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
