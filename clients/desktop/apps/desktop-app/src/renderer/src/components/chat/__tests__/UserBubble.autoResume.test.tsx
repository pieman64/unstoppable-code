import { renderToStaticMarkup } from 'react-dom/server';
import { ChatAppNameProvider } from '@canopy/ui-shared/components';
import { UserBubble } from '../UserBubble';
import type { DisplayMessage } from '../types';

jest.mock('@/lib/terminal-instances', () => ({
  getOrCreateInstance: jest.fn(),
  peekInstance: jest.fn(() => undefined),
  TERMINAL_BG_COLOR: '#0b0c10',
}));
jest.mock('@xterm/xterm', () => ({ Terminal: jest.fn() }));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: jest.fn() }));
jest.mock('@/stores/experimentalFeaturesStore', () => ({
  useExperimentalFeaturesEnabled: (): boolean => false,
}));

function userMessage(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: 'resume-1',
    role: 'user',
    blocks: [{ type: 'text', text: 'Continue' }],
    timestamp: new Date(2026, 9, 25, 21, 41).getTime(),
    ...overrides,
  };
}

function render(message: DisplayMessage): string {
  return renderToStaticMarkup(
    <ChatAppNameProvider value="Canopy">
      <UserBubble message={message} />
    </ChatAppNameProvider>,
  );
}

describe('UserBubble automatic resume (CAN-4897)', () => {
  it('replaces a generated nudge bubble with the shared marker', () => {
    const html = render(
      userMessage({
        userMessageSource: 'auto_resume',
        autoResume: {
          reason: 'app_shutdown',
          resumesUserMessageId: 'original',
          resendsUserMessage: false,
        },
      }),
    );
    expect(html).toContain('data-testid="auto-resume-marker"');
    expect(html).toContain('Canopy closed · resumed');
    expect(html).toContain('Sent automatically: Continue');
    // The message anchor survives for jumps, search and grouping.
    expect(html).toContain('data-chat-message-id="resume-1"');
    expect(html).not.toContain('portal-chat-message-content');
    expect(html).toContain('data-testid="auto-resume-copy"');
    expect(html).toContain('data-role="user"');
    expect(html.match(/data-testid="auto-resume-marker"/g)).toHaveLength(1);
  });

  it('keeps a re-sent prompt body under the marker', () => {
    const html = render(
      userMessage({
        blocks: [{ type: 'text', text: 'Fix the flaky build' }],
        inputMode: 'voice',
        userMessageSource: 'auto_resume',
        autoResume: {
          reason: 'usage_limit',
          providerName: 'Codex',
          resendsUserMessage: true,
        },
      }),
    );
    expect(html).toContain('Sent automatically · re-sent your last message');
    expect(html).toContain('Resumed after Codex usage limit');
    expect(html).toContain('Fix the flaky build');
    expect(html).toContain('portal-chat-message-content');
  });

  it('keeps content with generic attribution when metadata is unreadable', () => {
    const html = render(userMessage({ userMessageSource: 'auto_resume' }));
    expect(html).toContain('data-auto-resume-reason="unknown"');
    expect(html).toContain('Continue');
  });

  it('never infers a resume from the text of a human prompt', () => {
    const html = render(userMessage());
    expect(html).not.toContain('auto-resume-marker');
    expect(html).toContain('Continue');
  });
});
