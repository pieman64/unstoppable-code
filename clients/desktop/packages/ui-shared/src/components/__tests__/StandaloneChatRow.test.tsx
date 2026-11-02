/**
 * Server-rendered tests for the shared {@link StandaloneChatRow}. Verifies
 * provider icon dispatch, archive-button visibility, and archived treatment.
 */
import { renderToString } from 'react-dom/server';
import { StandaloneChatRow } from '../StandaloneChatRow';

/** Whitespace-delimited class tokens of the `<button>` carrying `testId`. */
function buttonClassTokens(html: string, testId: string): string[] {
  const tag = html.match(
    new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`),
  )?.[0];
  return tag?.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? [];
}

describe('StandaloneChatRow', () => {
  it('renders the title and model label', () => {
    const html = renderToString(
      <StandaloneChatRow title="Chat A" modelLabel="claude-3" />,
    );
    expect(html).toContain('Chat A');
    expect(html).toContain('claude-3');
    expect(html).toContain('rounded-row');
  });

  it('keeps long task titles on one flexible ellipsis line', () => {
    const html = renderToString(
      <StandaloneChatRow title="A deliberately long task title that must fit the sidebar" />,
    );

    expect(html).toContain('flex w-full min-w-0');
    expect(html).toContain(
      'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap',
    );
  });

  it('renders the shared Claude logo for providerType=claude', () => {
    const html = renderToString(
      <StandaloneChatRow title="Chat" providerType="claude" />,
    );
    expect(html).toContain('<svg');
  });

  it('renders the shared Codex logo for providerType=codex', () => {
    const html = renderToString(
      <StandaloneChatRow title="Chat" providerType="codex" />,
    );
    expect(html).toContain('<svg');
  });

  it('renders no provider icon when providerType is undefined', () => {
    const html = renderToString(<StandaloneChatRow title="Chat" />);
    expect(html).not.toContain('claude-logo');
    expect(html).not.toContain('codex-logo');
  });

  it('seats a 16px app provider glyph in the shared 20px leading slot', () => {
    const html = renderToString(
      <StandaloneChatRow title="Chat" providerType="claude" />,
    );
    expect(html).toContain(
      'inline-flex h-5 w-5 shrink-0 items-center justify-center fg-tertiary',
    );
    expect(html).toContain('width="16px"');
    expect(html).not.toContain('opacity-60');
  });

  it('uses the shared 32px sidebar row geometry', () => {
    const html = renderToString(<StandaloneChatRow title="Chat" />);
    expect(html).toContain('h-8 py-0 gap-1.5 rounded-row px-1.5');
    expect(html).not.toContain('px-3');
  });

  it('shows the archive button when onArchive is supplied and the chat is not archived', () => {
    const html = renderToString(
      <StandaloneChatRow title="Chat" onArchive={() => {}} />,
    );
    expect(html).toContain('Archive chat');
    expect(html).toContain('standalone-chat-row-archive');
  });

  it('keeps the archive button visible at rest on coarse pointers', () => {
    const html = renderToString(
      <StandaloneChatRow title="Chat" onArchive={() => {}} />,
    );
    const tokens = buttonClassTokens(html, 'standalone-chat-row-archive');

    expect(tokens).toEqual(
      expect.arrayContaining([
        'opacity-0',
        'group-hover:opacity-100',
        'pointer-coarse:opacity-100',
      ]),
    );
  });

  it('hides the archive button when onArchive is omitted', () => {
    const html = renderToString(<StandaloneChatRow title="Chat" />);
    expect(html).not.toContain('Archive chat');
  });

  it('hides the archive button on archived rows', () => {
    const html = renderToString(
      <StandaloneChatRow title="Chat" archived onArchive={() => {}} />,
    );
    expect(html).not.toContain('Archive chat');
  });

  it('marks archived rows with data-archived="true"', () => {
    const html = renderToString(<StandaloneChatRow title="Chat" archived />);
    expect(html).toContain('data-archived="true"');
  });

  it('applies the tertiary ink when archived', () => {
    const html = renderToString(<StandaloneChatRow title="Chat" archived />);
    expect(html).toContain('fg-tertiary hover:bg-subtle');
    expect(html).not.toContain('fg-secondary/60');
  });

  it('disables the row when archivingInFlight is true', () => {
    const html = renderToString(
      <StandaloneChatRow title="Chat" archivingInFlight />,
    );
    expect(html).toContain('pointer-events-none');
    expect(html).toContain('opacity-50');
  });

  it('forwards dataChatId for automation', () => {
    const html = renderToString(
      <StandaloneChatRow title="Chat" dataChatId="chat-7" />,
    );
    expect(html).toContain('data-standalone-chat-id="chat-7"');
  });

  it('selects with the background alone, never a weight or ink change on the title', () => {
    const selected = renderToString(
      <StandaloneChatRow title="Chat" selected />,
    );
    const idle = renderToString(<StandaloneChatRow title="Chat" />);
    expect(selected).toContain('bg-muted fg-primary');
    for (const html of [selected, idle]) {
      expect(html).not.toContain('font-semibold');
      expect(html).not.toContain('fg-primary/80');
      expect(html).toContain('text-s font-normal leading-snug');
    }
  });

  it('draws the archive action with the app archive glyph', () => {
    const html = renderToString(
      <StandaloneChatRow title="Chat" onArchive={() => {}} />,
    );
    expect(html).not.toContain('<rect x="2" y="3" width="20" height="5"');
    expect(html).toContain('rounded-md');
  });
});
