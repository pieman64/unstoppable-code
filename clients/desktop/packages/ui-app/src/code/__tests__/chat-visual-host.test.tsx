import { renderToString } from 'react-dom/server';
import type { CanopyCapabilities } from '@canopy/app-core';
import type { ChatVisualOwner } from '../chat-visual-host';

let capabilities: CanopyCapabilities;
jest.mock('@canopy/app-state', () => ({
  useCapabilities: (): CanopyCapabilities => capabilities,
}));

import {
  CHAT_VISUAL_TEST_IDS,
  ChatVisualHostProvider,
  useChatVisualHost,
  type ChatVisualHost,
} from '../chat-visual-host';
import { ChatVisualBlock } from '../ChatVisualBlock';

const owner: ChatVisualOwner = {
  messageId: 'message-1',
  toolUseId: 'tool-1',
  reference: {
    version: 1,
    visualId: 'vis_00000000-0000-0000-0000-000000000001',
    artifactId: `sha256-v1-${'a'.repeat(64)}`,
    sha256: 'a'.repeat(64),
    byteLength: 1,
    mediaType: 'text/html',
    title: 'Chart',
    maxHeight: 400,
  },
};

const host: ChatVisualHost = {
  read: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array()),
  openLink: (): void => {},
};

const baseCapabilities: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'read-only',
  routing: 'url',
  overviewNotifications: false,
};

function HostProbe(): JSX.Element {
  const value = useChatVisualHost();
  return <span>{value === host ? 'host' : 'null'}</span>;
}

describe('chat visual host contract', () => {
  beforeEach(() => {
    capabilities = { ...baseCapabilities };
  });

  it('defaults to null and provides the exact host value', () => {
    expect(renderToString(<HostProbe />)).toContain('null');
    expect(
      renderToString(
        <ChatVisualHostProvider value={host}>
          <HostProbe />
        </ChatVisualHostProvider>,
      ),
    ).toContain('host');
  });

  it.each([undefined, false])(
    'renders nothing when the capability is %s',
    (chatVisuals) => {
      capabilities = { ...baseCapabilities, chatVisuals };
      expect(
        renderToString(
          <ChatVisualHostProvider value={host}>
            <ChatVisualBlock owner={owner} variant="inline" />
          </ChatVisualHostProvider>,
        ),
      ).toBe('');
    },
  );

  it('renders nothing without a host', () => {
    capabilities = { ...baseCapabilities, chatVisuals: true };
    expect(
      renderToString(<ChatVisualBlock owner={owner} variant="inline" />),
    ).toBe('');
  });

  it('renders the contract marker only when both gates are present', () => {
    capabilities = { ...baseCapabilities, chatVisuals: true };
    const markup = renderToString(
      <ChatVisualHostProvider value={host}>
        <ChatVisualBlock owner={owner} variant="visual-only" />
      </ChatVisualHostProvider>,
    );
    expect(markup).toContain(`data-testid="${CHAT_VISUAL_TEST_IDS.block}"`);
    expect(markup).toContain('data-variant="visual-only"');
  });
});
