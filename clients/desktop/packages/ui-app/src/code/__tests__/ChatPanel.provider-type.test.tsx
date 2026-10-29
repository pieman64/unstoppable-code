import type { JSX } from 'react';
import { renderToString } from 'react-dom/server';
import type {
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';

// This suite pins prop threading only, so the composer is stubbed to a probe
// that surfaces `providerType` in the SSR output — the real composer's chip
// behavior (including the Codex display clamp) is covered by
// ChatComposer.test.tsx. Kept out of ChatPanel.test.tsx, whose assertions
// need the real composer markup.
jest.mock('../ChatComposer', () => ({
  __esModule: true,
  ChatComposer: ({
    providerType,
    slashTriggerCharacters,
  }: {
    providerType?: string;
    slashTriggerCharacters?: readonly string[];
  }): JSX.Element => (
    <div
      data-testid="composer-probe"
      data-provider-type={providerType ?? 'none'}
      data-slash-triggers={slashTriggerCharacters?.join(',')}
    />
  ),
}));

import { ChatPanel } from '../ChatPanel';

function mockClient(): CanopyClient {
  return {
    capabilities: {
      localExecution: true,
      terminalPty: true,
      fileSystemAccess: 'read-write',
      voice: false,
      settingsScope: 'full',
      pipelines: 'execute',
      routing: 'in-memory',
      overviewNotifications: true,
    },
    query<K extends QueryName>(): Promise<QueryMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    command<K extends CommandName>(): Promise<CommandMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

describe('ChatPanel providerType threading', () => {
  it('threads providerType into the default composer', () => {
    const out = renderToString(
      <CanopyClientProvider client={mockClient()}>
        <ChatPanel chatId="c1" onSend={() => {}} providerType="codex" />
      </CanopyClientProvider>,
    );
    expect(out).toContain('data-provider-type="codex"');
  });

  it('omits providerType from the composer when the host passes none', () => {
    const out = renderToString(
      <CanopyClientProvider client={mockClient()}>
        <ChatPanel chatId="c1" onSend={() => {}} />
      </CanopyClientProvider>,
    );
    expect(out).toContain('data-provider-type="none"');
  });

  it('threads configured slash trigger characters into the default composer', () => {
    const out = renderToString(
      <CanopyClientProvider client={mockClient()}>
        <ChatPanel
          chatId="c1"
          onSend={() => {}}
          composer={{ slashTriggerCharacters: ['/'] }}
        />
      </CanopyClientProvider>,
    );
    expect(out).toContain('data-slash-triggers="/"');
  });
});
