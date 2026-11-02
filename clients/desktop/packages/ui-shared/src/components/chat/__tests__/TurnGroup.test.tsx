/**
 * Server-rendered tests for the shared {@link TurnGroup} wrapper. Validates
 * the user-bubble slot, intermediate-region summary chip, reverted fade, and
 * final/timer slot rendering.
 */
import { renderToString } from 'react-dom/server';
import { TurnGroup } from '../TurnGroup';
import { ChatLookProvider } from '../../chat-look';

describe('TurnGroup', () => {
  it('uses interrupted completion for the clean summary of a shared run', () => {
    const html = renderToString(
      <ChatLookProvider value="clean">
        <TurnGroup
          userBubble={<span>u</span>}
          intermediateBlocks={<span>tools</span>}
          intermediateSummary={{ read: 1, edit: 1 }}
          intermediateElapsedMs={14000}
          intermediateOutcomes={{ blocked: 0, failed: 0, interrupted: 1 }}
          finalBlocks={<span>interrupted reply</span>}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('Interrupted after 14s');
    expect(html).not.toContain('Worked for');
  });

  it('renders the userBubble + finalBlocks slots', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <TurnGroup
          userBubble={<span data-testid="user">u</span>}
          finalBlocks={<span data-testid="final">f</span>}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-testid="user"');
    expect(html).toContain('data-testid="final"');
  });

  it('renders the chip summary + hides intermediate blocks when collapsed by default', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <TurnGroup
          userBubble={<span data-testid="user">u</span>}
          intermediateSummary={{ bash: 2, read: 1 }}
          intermediateBlocks={<span data-testid="inter">i</span>}
          finalBlocks={<span data-testid="final">f</span>}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-chip="bash"');
    expect(html).toContain('data-tool-chip="read"');
    // Intermediate region hidden until user expands.
    expect(html).not.toContain('data-testid="turn-group-intermediate-region"');
    expect(html).not.toContain('data-testid="inter"');
  });

  it('renders the intermediate region when collapsedByDefault=false', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <TurnGroup
          userBubble={<span data-testid="user">u</span>}
          intermediateSummary={{ bash: 1 }}
          intermediateBlocks={<span data-testid="inter">i</span>}
          finalBlocks={<span data-testid="final">f</span>}
          collapsedByDefault={false}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-testid="turn-group-intermediate-region"');
    expect(html).toContain('data-testid="inter"');
  });

  it('renders intermediate blocks inline when there is no summary', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <TurnGroup
          userBubble={<span>u</span>}
          intermediateBlocks={<span data-testid="inter">i</span>}
          finalBlocks={<span>f</span>}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-testid="turn-group-intermediate-region"');
    expect(html).toContain('data-testid="inter"');
  });

  it('renders the reverted-collapsed bar when reverted=true', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <TurnGroup
          userBubble={<span data-testid="user">u</span>}
          finalBlocks={<span data-testid="final">f</span>}
          reverted
          revertedPreview="fix typo"
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-reverted="true"');
    expect(html).toContain('Reverted');
    expect(html).toContain('fix typo');
    // Collapsed reverted hides the user / final slots.
    expect(html).not.toContain('data-testid="user"');
    expect(html).not.toContain('data-testid="final"');
  });

  it('renders the turn-timer slot', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <TurnGroup
          userBubble={<span>u</span>}
          finalBlocks={<span>f</span>}
          turnTimerSlot={<span data-testid="timer">t</span>}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-testid="timer"');
  });

  it('renders the trailing slot below the final blocks', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <TurnGroup
          userBubble={<span>u</span>}
          finalBlocks={<span>f</span>}
          trailingSlot={<span data-testid="diff-summary">d</span>}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-testid="diff-summary"');
  });

  it('passes the app icon to the collapsed intermediate summary', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <TurnGroup
          userBubble={<span>u</span>}
          intermediateSummary={{ canopy: 1 }}
          intermediateBlocks={<span>i</span>}
          finalBlocks={<span>f</span>}
          appIcon={<svg data-testid="brand-app-icon" />}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-chip="canopy"');
    expect(html).toContain('data-testid="brand-app-icon"');
  });

  it('honors the dataTestId hook', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <TurnGroup
          userBubble={<span>u</span>}
          finalBlocks={<span>f</span>}
          dataTestId="turn"
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-testid="turn"');
  });
});
