import { renderToString } from 'react-dom/server';
import { ChatToolResultPart } from '../ChatToolResultPart';
import {
  ChatVisualHostProvider,
  type ChatVisualHost,
  type ChatVisualOwner,
} from '../chat-visual-host';

let capable = false;
jest.mock('@canopy/app-state', () => ({
  useCapabilities: (): { chatVisuals: boolean } => ({ chatVisuals: capable }),
}));

const visual: ChatVisualOwner = {
  messageId: 'message-1',
  toolUseId: 'tool-1',
  reference: {
    version: 1,
    visualId: 'vis_00000000-0000-0000-0000-000000000001',
    artifactId: 'sha256-v1-abc',
    sha256: 'a'.repeat(64),
    byteLength: 12,
    mediaType: 'text/html',
    title: 'Chart',
    maxHeight: 400,
  },
};
const host: ChatVisualHost = {
  read: () => Promise.resolve(new Uint8Array()),
  openLink: () => {},
};

describe('ChatToolResultPart visual gate', () => {
  afterEach(() => {
    capable = false;
  });

  it('keeps the prior row when the host has no visual capability', () => {
    const markup = renderToString(
      <ChatVisualHostProvider value={host}>
        <ChatToolResultPart content="done" visual={visual} />
      </ChatVisualHostProvider>,
    );
    expect(markup).toContain('Tool result');
    expect(markup).not.toContain('chat-visual-block');
  });

  it('renders no new row for a visual-only part without a host', () => {
    expect(
      renderToString(<ChatToolResultPart content="" visual={visual} />),
    ).toBe('');
  });

  it('renders the inline block for a capable host', () => {
    capable = true;
    const markup = renderToString(
      <ChatVisualHostProvider value={host}>
        <ChatToolResultPart content="" visual={visual} />
      </ChatVisualHostProvider>,
    );
    expect(markup).toContain('data-variant="inline"');
    expect(markup).not.toContain('Tool result');
  });
});
