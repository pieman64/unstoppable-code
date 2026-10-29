import {
  hasRenderableTranscriptPrefix,
  markTranscriptProbe,
  transcriptChangedSinceProbe,
} from '../lib/pipelineTranscriptAvailability';

const ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg-1',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello from the agent' }],
  },
});

describe('pipelineTranscriptAvailability', () => {
  it('asks for another probe when the final line completes in place', () => {
    const partial = ['{"type":"system"}', '{"type":"assis'];
    const mark = markTranscriptProbe(partial);

    expect(transcriptChangedSinceProbe(mark, [...partial])).toBe(false);
    expect(
      transcriptChangedSinceProbe(mark, [
        '{"type":"system"}',
        '{"type":"assistant"}',
      ]),
    ).toBe(true);
    expect(
      transcriptChangedSinceProbe(mark, [...partial, '{"type":"user"}']),
    ).toBe(true);
    expect(transcriptChangedSinceProbe(null, partial)).toBe(true);
  });

  it('finds a renderable message and reports none for a plain log', () => {
    expect(hasRenderableTranscriptPrefix([ASSISTANT_LINE], 'claude')).toBe(
      true,
    );
    expect(
      hasRenderableTranscriptPrefix(['npm run build', 'done'], 'claude'),
    ).toBe(false);
    expect(hasRenderableTranscriptPrefix([], 'claude')).toBe(false);
  });

  it('finds a message past the first probe window', () => {
    const lines = [
      ...Array.from({ length: 200 }, (_, index) => `plain line ${index}`),
      ASSISTANT_LINE,
    ];

    expect(hasRenderableTranscriptPrefix(lines, 'claude')).toBe(true);
  });
});
