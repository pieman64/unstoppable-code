import type { JSX } from 'react';
import { renderToString } from 'react-dom/server';

// The @canopy/ui-rich Slate editor needs a DOM (jsdom); these are node/SSR
// (renderToString) tests, so stub it to a div carrying the same test id. Slate
// editing/serialization is covered by ui-rich's own tests + live desktop QA.
jest.mock('@canopy/ui-rich', () => ({
  __esModule: true,
  SlateEditor: ({
    dataTestId,
    placeholder,
  }: {
    dataTestId?: string;
    placeholder?: string;
  }): JSX.Element => <div data-testid={dataTestId}>{placeholder}</div>,
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

import { ChatComposer } from '../ChatComposer';

describe('ChatComposer', () => {
  it('renders the input and a Send control', () => {
    const out = renderToString(<ChatComposer onSend={() => {}} />);
    expect(out).toContain('data-testid="chat-composer-input"');
    expect(out).toContain('data-testid="chat-composer-send"');
  });

  it('shows Stop instead of Send while streaming', () => {
    const out = renderToString(
      <ChatComposer onSend={() => {}} onStop={() => {}} isStreaming={true} />,
    );
    expect(out).toContain('data-testid="chat-composer-stop"');
    expect(out).not.toContain('data-testid="chat-composer-send"');
  });

  it('renders plan-mode and thinking chips when their handlers are provided', () => {
    const out = renderToString(
      <ChatComposer
        onSend={() => {}}
        planMode={true}
        onTogglePlanMode={() => {}}
        thinkingLevel="high"
        onCycleThinking={() => {}}
      />,
    );
    expect(out).toContain('data-testid="chat-composer-plan"');
    expect(out).toContain('aria-label="Toggle plan mode"');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('data-testid="chat-composer-thinking"');
    expect(out).toContain('aria-label="Cycle thinking level"');
    // The level reads through the rich tooltip, never a native title.
    expect(out).not.toContain('title=\"Thinking: high\"');
    // The chip draws the app `ThinkingIcon` (the neurology glyph), not the
    // legacy two-lobe brain the package barrel still exports for transcript
    // thinking blocks.
    expect(out).toContain('data-glyph="brain-circuit"');
    expect(out).not.toContain('data-glyph="brain"');
    expect(out).toMatch(
      /data-testid="chat-composer-plan"[^>]*class="[^"]*bg-warning-subtle[^"]*fg-warning/,
    );
    // An active (non-off) level shows the capitalized label + amber treatment.
    expect(out).toContain('>High<');
    expect(out).toMatch(
      /data-testid="chat-composer-thinking"[^>]*class="[^"]*bg-warning-subtle[^"]*fg-warning/,
    );
  });

  // The chip's displayed tier and label come from the shared composer logic
  // (`resolveComposerThinking` + `THINKING_LEVEL_LABELS`), so this composer,
  // the portal composer and the desktop composer clamp and name the tiers
  // identically (web chat parity, slice 3).
  it('shows a Codex max level as Extra High, the tier that provider exposes', () => {
    const out = renderToString(
      <ChatComposer
        onSend={() => {}}
        providerType="codex"
        thinkingLevel="max"
        onCycleThinking={() => {}}
      />,
    );
    expect(out).toContain('>Extra High<');
    expect(out).not.toContain('>Max<');
  });

  it('keeps a max level on a provider without the Codex clamp', () => {
    const out = renderToString(
      <ChatComposer
        onSend={() => {}}
        providerType="claude"
        thinkingLevel="max"
        onCycleThinking={() => {}}
      />,
    );
    expect(out).toContain('>Max<');
    expect(out).not.toContain('>Extra High<');
  });

  it('never labels a chip with a tier the UI does not offer', () => {
    // `low` is a wire level with no UI tier. Capitalizing the raw level by
    // hand used to render it as `Low`; normalizing first lands on a real tier.
    const out = renderToString(
      <ChatComposer
        onSend={() => {}}
        thinkingLevel="low"
        onCycleThinking={() => {}}
      />,
    );
    expect(out).not.toContain('>Low<');
    // Pin where it lands, not just where it does not: `low` normalizes to
    // `medium`, so dropping the label entirely would not pass either.
    expect(out).toContain('>Medium<');
  });

  it('renders an icon-only idle thinking chip when the level is off', () => {
    const out = renderToString(
      <ChatComposer
        onSend={() => {}}
        thinkingLevel="off"
        onCycleThinking={() => {}}
      />,
    );
    expect(out).toContain('data-testid="chat-composer-thinking"');
    // The level reads through the rich tooltip, never a native title.
    expect(out).not.toContain('title=\"Thinking: off\"');
    // Idle: no label span and no active amber treatment.
    expect(out).not.toContain('>None<');
    expect(out).not.toMatch(
      /data-testid="chat-composer-thinking"[^>]*class="[^"]*bg-warning-subtle/,
    );
  });

  it('gives the max thinking level its gradient treatment', () => {
    const out = renderToString(
      <ChatComposer
        onSend={() => {}}
        thinkingLevel="max"
        onCycleThinking={() => {}}
      />,
    );
    // The level reads through the rich tooltip, never a native title.
    expect(out).not.toContain('title=\"Thinking: max\"');
    expect(out).toContain('>Max<');
    expect(out).toContain('linear-gradient(90deg');
  });

  it('clamps a persisted max level to xhigh for Codex hosts', () => {
    const out = renderToString(
      <ChatComposer
        onSend={() => {}}
        thinkingLevel="max"
        onCycleThinking={() => {}}
        providerType="codex"
      />,
    );
    // The level reads through the rich tooltip, never a native title.
    expect(out).not.toContain('title=\"Thinking: xhigh\"');
    expect(out).toContain('>Extra High<');
    expect(out).not.toContain('linear-gradient(90deg');
  });

  it('omits the plan/thinking chips when no handlers are given', () => {
    const out = renderToString(<ChatComposer onSend={() => {}} />);
    expect(out).not.toContain('data-testid="chat-composer-plan"');
    expect(out).not.toContain('data-testid="chat-composer-thinking"');
  });

  it('disables Send when no onSend is provided (read-only host)', () => {
    const out = renderToString(<ChatComposer />);
    expect(out).toContain('data-testid="chat-composer-send"');
    expect(out).toContain('disabled=""');
  });

  it('renders with typeahead providers wired (menus closed by default)', () => {
    const out = renderToString(
      <ChatComposer
        onSend={() => {}}
        slashCommands={[{ name: 'plan' }]}
        fileSearch={() => []}
        fileTypeaheadMultiRepo
      />,
    );
    expect(out).toContain('data-testid="chat-composer-input"');
    // Both typeahead hooks report closed in the stub, so neither menu renders.
    expect(out).not.toContain('data-testid="slash-menu"');
    expect(out).not.toContain('data-testid="file-menu"');
  });

  it('only advertises typeahead hints for wired capabilities', () => {
    // The bare fallback is `Send a message`, the string both hosts show: this
    // composer used to keep its own copy that ended in an ellipsis.
    expect(renderToString(<ChatComposer onSend={() => {}} />)).toContain(
      'Send a message',
    );
    expect(renderToString(<ChatComposer onSend={() => {}} />)).not.toContain(
      'Send a message…',
    );
    expect(
      renderToString(
        <ChatComposer onSend={() => {}} slashCommands={[{ name: 'plan' }]} />,
      ),
    ).toContain('Send a message, / for skills and commands');
    expect(
      renderToString(
        <ChatComposer
          onSend={() => {}}
          slashCommands={[{ name: 'plan' }]}
          fileSearch={() => []}
        />,
      ),
    ).toContain('Send a message, @ to mention, / for skills and commands');
  });
});
