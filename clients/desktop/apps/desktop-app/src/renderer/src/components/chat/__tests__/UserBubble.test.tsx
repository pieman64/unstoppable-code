import {
  PLUGIN_MENTION_KIND,
  buildPluginMentionAbsolutePath,
} from '@canopy/desktop-shared/lib/plugin-mention';
import { renderToStaticMarkup } from 'react-dom/server';
import { LayoutTierProvider } from '@canopy/ui-shared/components';
import { UserBubble } from '../UserBubble';
import { MutedUserBubblesContext } from '../muted-user-bubbles-context';
import type { DisplayMessage } from '../types';

jest.mock('@/lib/terminal-instances', () => ({
  getOrCreateInstance: jest.fn(),
  peekInstance: jest.fn(() => undefined),
  TERMINAL_BG_COLOR: '#0b0c10',
}));

jest.mock('@xterm/xterm', () => ({ Terminal: jest.fn() }));

let mockEarlyAccess = false;
jest.mock('@/stores/labsExperimentsStore', () => ({
  useLabsExperimentEnabled: (): boolean => mockEarlyAccess,
}));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: jest.fn() }));

function userMessage(text: string): DisplayMessage {
  return {
    id: 'user-1',
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
  };
}

/**
 * The sent bubble renders the user's text through the real block renderer,
 * so this covers the wiring from the bubble down to the markdown options —
 * `WatcherFiredDisplay.test.tsx` mocks the block renderer away.
 */
describe('UserBubble line breaks (CAN-2811)', () => {
  // A user who typed deliberate single line breaks must see them. Markdown
  // treats a lone newline as a soft break, which the browser collapses to a
  // space, so the bubble folded three lines into one paragraph.
  it('keeps single line breaks as separate lines', () => {
    const html = renderToStaticMarkup(
      <UserBubble message={userMessage('line one\nline two\nline three')} />,
    );

    expect(html).toContain('<p>line one<br/>line two<br/>line three</p>');
  });

  it('still separates blank-line paragraphs and leaves code blocks alone', () => {
    const html = renderToStaticMarkup(
      <UserBubble
        message={userMessage(
          'first\nsecond\n\nnext paragraph\n\n```\ncode\nmore\n```',
        )}
      />,
    );

    expect(html).toContain('<p>first<br/>second</p>');
    expect(html).toContain('<p>next paragraph</p>');
    expect(html).toContain('code\nmore');
    expect(html).not.toContain('code<br/>more');
  });
});

describe('UserBubble plugin mentions', () => {
  const pluginReference = {
    displayPath: 'figma',
    absolutePath: buildPluginMentionAbsolutePath({
      marketplaceId: 'claude-plugins-official',
      pluginName: 'figma',
    }),
    kind: PLUGIN_MENTION_KIND,
  };

  it('renders a mentioned plugin as a chip inside the sent text', () => {
    const html = renderToStaticMarkup(
      <UserBubble
        message={{
          id: 'user-2',
          role: 'user',
          timestamp: 1,
          blocks: [
            { type: 'file_references', references: [pluginReference] },
            { type: 'text', text: 'Use figma to export the frame' },
          ],
        }}
      />,
    );

    expect(html).toContain('data-testid="plugin-mention"');
    expect(html).toContain('title="Plugin: figma"');
    expect(html).toMatch(
      /<p>Use <span[^>]*data-testid="plugin-mention"[^>]*>.*?figma.*?<\/span> to export the frame<\/p>/,
    );
  });

  it('leaves plain prose alone when the message mentions no plugin', () => {
    const html = renderToStaticMarkup(
      <UserBubble message={userMessage('Use figma to export the frame')} />,
    );

    expect(html).not.toContain('data-testid="plugin-mention"');
  });
});

/**
 * A steer submitted mid-turn is user-authored content inside that turn, so it
 * gets the "Steering" chip. A steer the provider only picks up after the turn
 * settled starts a brand new turn (`steering.startsTurn: true`) — it is an
 * ordinary prompt and must read like one.
 */
describe('UserBubble steering title', () => {
  function steeringMessage(startsTurn: boolean): DisplayMessage {
    return {
      id: 'user-3',
      role: 'user',
      timestamp: 1,
      blocks: [
        {
          type: 'text',
          text: 'Check the cached-token numbers first',
          steering: { startsTurn, rootUserMessageId: 'root-1' },
        },
      ],
    };
  }

  it('marks an in-turn steer as Steering', () => {
    const html = renderToStaticMarkup(
      <UserBubble message={steeringMessage(false)} />,
    );

    expect(html).toContain('data-testid="steering-title"');
  });

  it('leaves a turn-starting pickup unmarked', () => {
    const html = renderToStaticMarkup(
      <UserBubble message={steeringMessage(true)} />,
    );

    expect(html).not.toContain('data-testid="steering-title"');
  });
});

describe('UserBubble attachments', () => {
  const message: DisplayMessage = {
    id: 'user-3',
    role: 'user',
    timestamp: 1,
    blocks: [{ type: 'text', text: 'see the references' }],
    attachmentPaths: [
      '/tmp/attachments/shot.png',
      '/tmp/attachments/notes.txt',
    ],
  };

  afterEach(() => {
    mockEarlyAccess = false;
  });

  it('shows sent images inside the bubble with early access, files below it', () => {
    mockEarlyAccess = true;
    const html = renderToStaticMarkup(<UserBubble message={message} />);

    const surface = html.indexOf('data-testid="portal-chat-message-content"');
    const images = html.indexOf('data-testid="message-image-attachments"');
    const text = html.indexOf('see the references');
    const chip = html.indexOf('data-testid="file-attachment-chip"');
    // Inside the bubble, above the text; the other file stays a chip below.
    expect(surface).toBeGreaterThan(-1);
    expect(images).toBeGreaterThan(surface);
    expect(text).toBeGreaterThan(images);
    expect(chip).toBeGreaterThan(text);
    expect(html).toContain('aria-label="Open shot.png"');
    expect(html.match(/data-testid="file-attachment-chip"/g)).toHaveLength(1);
    expect(html.slice(chip)).toContain('notes.txt');
    expect(html.slice(chip)).not.toContain('shot.png');
  });

  it('renders images inside bubbles without a Labs opt-in', () => {
    const html = renderToStaticMarkup(<UserBubble message={message} />);

    expect(html).toContain('data-testid="message-image-attachments"');
    expect(html.match(/data-testid="file-attachment-chip"/g)).toHaveLength(1);
  });
});

describe('UserBubble actions on a narrow transcript', () => {
  afterEach(() => {
    mockEarlyAccess = false;
  });

  function renderPhone(): string {
    return renderToStaticMarkup(
      <LayoutTierProvider tier="phone">
        <UserBubble message={userMessage('hey')} />
      </LayoutTierProvider>,
    );
  }

  it('keeps Copy on the corner without a Labs opt-in', () => {
    const html = renderPhone();
    expect(html).toContain('absolute -right-2 -top-2');
    expect(html).not.toContain(' pr-9');
  });

  it('puts Copy on the bubble corner, reserving no room, under early access', () => {
    mockEarlyAccess = true;
    const html = renderPhone();
    expect(html).toContain('absolute -right-2 -top-2');
    expect(html).not.toContain(' pr-9');
  });
});

describe('UserBubble surface', () => {
  function render(muted?: boolean): string {
    const bubble = <UserBubble message={userMessage('hey')} />;
    return renderToStaticMarkup(
      muted === undefined ? (
        bubble
      ) : (
        <MutedUserBubblesContext.Provider value={muted}>
          {bubble}
        </MutedUserBubblesContext.Provider>
      ),
    );
  }

  /** The bubble's own class (its hover actions keep their badge chrome). */
  function bubbleClass(html: string): string {
    return (
      /class="([^"]*)" data-testid="portal-chat-message-content"/.exec(
        html,
      )?.[1] ?? ''
    );
  }

  it('is raised with a shadow by default', () => {
    expect(bubbleClass(render())).toContain('rounded-xl bg-quaternary');
    expect(bubbleClass(render())).toContain('shadow-sm');
    expect(bubbleClass(render(false))).toContain('shadow-sm');
  });

  it('is flat and muted where the surface asks (App Advisor)', () => {
    const bubble = bubbleClass(render(true));
    expect(bubble).toContain('rounded-xl bg-muted');
    expect(bubble).not.toContain('shadow');
    expect(bubble).not.toContain('ring');
  });
});

describe('UserBubble agent sender', () => {
  it('keeps agent identity alongside steering and copy excludes the title', () => {
    const message: DisplayMessage = {
      ...userMessage('Visible body'),
      agentSent: {
        sender: {
          kind: 'bot',
          botId: 'app_advisor',
          taskId: 'task',
          chatId: 'sender',
        },
        chatTitle: 'Captured agent',
        projectLabel: 'App Advisor',
      },
      blocks: [
        { type: 'text', text: 'Visible body', steering: { startsTurn: false } },
      ],
    };
    const html = renderToStaticMarkup(
      <UserBubble
        message={message}
        receivingContext={{ kind: 'bot', botId: 'app_advisor' }}
      />,
    );
    expect(html).toContain('data-testid="agent-sent-title"');
    expect(html).toContain('Captured agent');
    expect(html).toContain('>Steering<');
    expect(html).not.toContain('App Advisor');
  });
});
