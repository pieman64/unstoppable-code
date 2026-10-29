/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import type { ChatVisualOwner } from '@canopy/ui-app';
import type * as UiAppModule from '@canopy/ui-app';
import { ChatBlockRenderer } from '../ChatBlockRenderer';
import { ChatMessageItem } from '../ChatMessageItem';
import type { DisplayBlock, DisplayMessage } from '../types';

const mockVisualOwners: ChatVisualOwner[] = [];
jest.mock('@canopy/ui-app', () => ({
  ...jest.requireActual<typeof UiAppModule>('@canopy/ui-app'),
  ChatVisualBlock: ({
    owner,
    variant,
  }: {
    owner: ChatVisualOwner;
    variant: string;
  }): JSX.Element => {
    mockVisualOwners.push(owner);
    return <span data-testid="chat-visual-block" data-variant={variant} />;
  },
  ChatVisualSourceButton: (): null => null,
}));

const reference = {
  version: 1 as const,
  visualId: 'vis_123e4567-e89b-12d3-a456-426614174000',
  artifactId: `sha256-v1-${'a'.repeat(64)}`,
  sha256: 'a'.repeat(64),
  byteLength: 42,
  mediaType: 'text/html' as const,
  title: 'Chart',
  maxHeight: 320,
};

function toolBlock(
  result?: Extract<DisplayBlock, { type: 'tool_use' }>['result'],
): DisplayBlock {
  return {
    type: 'tool_use',
    toolUseId: 'tool-1',
    toolName: 'mcp__canopy__ShowVisual',
    input: '{}',
    result,
  };
}

const visualResult = {
  output: 'Shown',
  isError: false,
  messageId: 'result-1',
  toolUseId: 'tool-1',
  visualRef: reference,
};

describe('desktop visual result mounting', () => {
  beforeEach(() => mockVisualOwners.splice(0));

  it('mounts after the owning tool row and keeps owner identity stable', () => {
    const block = toolBlock(visualResult);
    const first = renderToStaticMarkup(<ChatBlockRenderer block={block} />);
    renderToStaticMarkup(<ChatBlockRenderer block={block} />);
    expect(first.indexOf('chat-tool-call')).toBeLessThan(
      first.indexOf('chat-visual-block'),
    );
    expect(mockVisualOwners).toHaveLength(2);
    expect(mockVisualOwners[0]).toBe(mockVisualOwners[1]);
    expect(mockVisualOwners[0]).toEqual({
      messageId: 'result-1',
      toolUseId: 'tool-1',
      reference,
    });
  });

  it('does not mount without metadata, on error, or without owner IDs', () => {
    for (const result of [
      { ...visualResult, visualRef: undefined },
      { ...visualResult, isError: true },
      { ...visualResult, messageId: undefined },
    ]) {
      expect(
        renderToStaticMarkup(<ChatBlockRenderer block={toolBlock(result)} />),
      ).not.toContain('chat-visual-block');
    }
  });

  it('renders a visual-only projection without its tool row or other blocks', () => {
    const message: DisplayMessage = {
      id: 'result-1',
      role: 'assistant',
      timestamp: 1,
      blocks: [toolBlock(visualResult), { type: 'text', text: 'Hidden prose' }],
    };
    const html = renderToStaticMarkup(
      <ChatMessageItem
        message={message}
        visualOnly
        chatPendingQuestions={[]}
      />,
    );
    expect(html).toContain('data-variant="visual-only"');
    expect(html).not.toContain('chat-tool-call');
    expect(html).not.toContain('Hidden prose');
  });
});
