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

// The composer's @canopy/ui-rich Slate editor needs jsdom; stub it for SSR.
jest.mock('@canopy/ui-rich', () => ({
  __esModule: true,
  SlateEditor: ({ dataTestId }: { dataTestId?: string }): JSX.Element => (
    <div data-testid={dataTestId} />
  ),
  SlashCommandMenu: (): JSX.Element => <div data-testid="slash-menu" />,
  FileTypeaheadMenu: (): JSX.Element => <div data-testid="file-menu" />,
  createChatEditor: (): Record<string, unknown> => ({}),
  createEmptyValue: (): unknown[] => [],
  serializeEditorValue: (): { text: string; fileReferences: unknown[] } => ({
    text: '',
    fileReferences: [],
  }),
  useSlashCommands: (): Record<string, unknown> => ({
    isOpen: false,
    filteredCommands: [],
    selectedIndex: 0,
    isDiscovering: false,
    onKeyDown: (): boolean => false,
    selectCommand: (): void => {},
    close: (): void => {},
  }),
  useFileTypeahead: (): Record<string, unknown> => ({
    isOpen: false,
    query: '',
    filteredFiles: [],
    selectedIndex: 0,
    onKeyDown: (): boolean => false,
    selectFile: (): void => {},
    close: (): void => {},
  }),
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

describe('ChatPanel', () => {
  it('renders the empty transcript + composer for a fresh chat', () => {
    const out = renderToString(
      <CanopyClientProvider client={mockClient()}>
        <ChatPanel chatId="c1" onSend={() => {}} />
      </CanopyClientProvider>,
    );
    expect(out).toContain('data-testid="chat-panel"');
    expect(out).toContain('data-testid="chat-transcript-empty"');
    expect(out).not.toContain('data-testid="chat-transcript-loading"');
    expect(out).toContain('data-testid="chat-composer"');
    expect(out).toContain('data-testid="chat-composer-send"');
  });

  it('marks the whole chat, transcript and composer, as a chat window', () => {
    const out = renderToString(
      <CanopyClientProvider client={mockClient()}>
        <ChatPanel chatId="c1" onSend={() => {}} />
      </CanopyClientProvider>,
    );
    // The shared stylesheet keeps plain line breaks inside it.
    const root = out.match(/^<div [^>]*>/)?.[0] ?? '';
    expect(root).toContain('data-testid="chat-panel"');
    expect(root).toContain('data-chat-window');
    expect(out.indexOf('data-testid="chat-composer"')).toBeGreaterThan(0);
  });

  it('keeps a host footer status on screen while the transcript chunk loads', () => {
    const out = renderToString(
      <CanopyClientProvider client={mockClient()}>
        <ChatPanel
          chatId="c1"
          onSend={() => {}}
          footerStatus={<p data-testid="host-footer-status">Starting</p>}
        />
      </CanopyClientProvider>,
    );
    // A pending first send is not an empty chat, even before the store has
    // absorbed its queue: the transcript mounts and its fallback carries the
    // status so the wait copy never drops out.
    expect(out).not.toContain('data-testid="chat-transcript-empty"');
    expect(out).toContain('data-testid="chat-transcript-loading"');
    expect(out).toContain('data-testid="host-footer-status"');
  });

  it('renders without a send control on a read-only host', () => {
    const out = renderToString(
      <CanopyClientProvider client={mockClient()}>
        <ChatPanel chatId="c1" />
      </CanopyClientProvider>,
    );
    // Send button still renders but is disabled (no onSend threaded through).
    expect(out).toContain('data-testid="chat-composer-send"');
    expect(out).toContain('disabled=""');
  });

  it('accepts composer typeahead providers and still renders the composer', () => {
    const out = renderToString(
      <CanopyClientProvider client={mockClient()}>
        <ChatPanel
          chatId="c1"
          onSend={() => {}}
          composer={{
            slashCommands: [{ name: 'plan' }],
            fileSearch: () => [],
            fileTypeaheadMultiRepo: true,
          }}
        />
      </CanopyClientProvider>,
    );
    expect(out).toContain('data-testid="chat-composer"');
    expect(out).toContain('data-testid="chat-composer-input"');
  });

  it('substitutes a host composer via renderComposer and hands back store controls', () => {
    let seen: { isStreaming: boolean; planMode: boolean } | null = null;
    const out = renderToString(
      <CanopyClientProvider client={mockClient()}>
        <ChatPanel
          chatId="c1"
          onSend={() => {}}
          renderComposer={(controls): JSX.Element => {
            seen = {
              isStreaming: controls.isStreaming,
              planMode: controls.planMode,
            };
            return <div data-testid="host-composer" />;
          }}
        />
      </CanopyClientProvider>,
    );
    // The host composer replaces the built-in one entirely.
    expect(out).toContain('data-testid="host-composer"');
    expect(out).not.toContain('data-testid="chat-composer"');
    // A fresh thread hands back idle store controls.
    expect(seen).toEqual({ isStreaming: false, planMode: false });
  });
});
