import {
  codexDynamicToolOutput,
  codexDynamicToolOutputChunks,
  previewCodexDynamicToolContent,
} from '../codex-dynamic-tool-results';
import { CODEX_TOOL_OUTPUT_CHUNK_MAX_CHARS } from '../codex-mcp-tool-results';

describe('codexDynamicToolOutput', () => {
  it('retains 131,082 characters and content after item 100', () => {
    const contentItems = Array.from({ length: 100 }, () => ({
      type: 'inputText',
      text: 'x'.repeat(1308),
    }));
    contentItems.push({
      type: 'inputText',
      text: `after-item-100:${'y'.repeat(57)}end-marker`,
    });
    const canonical = codexDynamicToolOutput({ contentItems, success: true });
    expect(canonical.length).toBe(131_082);
    expect(canonical).toContain('after-item-100');
    expect(canonical).toContain('end-marker');
    expect(
      previewCodexDynamicToolContent({ contentItems, success: true }),
    ).not.toContain('end-marker');
  });

  it('keeps media and encrypted placeholders without retaining binary data', () => {
    expect(
      codexDynamicToolOutput({
        contentItems: [
          { type: 'input_image', image_url: 'private' },
          { type: 'inputAudio', data: 'private' },
          { type: 'encrypted_content', data: 'private' },
          { type: 'unknown' },
          null,
        ],
        success: false,
      }),
    ).toBe(
      '[image output omitted]\n\n[audio output omitted]\n\n[encrypted output omitted]\n\n[unsupported output omitted]',
    );
  });
});

describe('codexDynamicToolOutputChunks', () => {
  const pair = '\u{1F600}';
  const fixtures: Array<[string, unknown, boolean | null]> = [
    ['not an array', undefined, true],
    ['empty failed', [], false],
    ['no records', [null, 3, 'text'], null],
    [
      'mixed items',
      [
        { type: 'inputText', text: 'first' },
        { type: 'input_text', text: '' },
        { type: 'inputText' },
        null,
        { type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' },
        { type: 'input_audio' },
        { type: 'encrypted_content', encrypted_content: 'secret' },
        { type: 'other' },
      ],
      true,
    ],
    [
      'large multibyte text',
      [
        {
          type: 'inputText',
          text: `${'a'.repeat(16_383)}${pair}${'é'.repeat(70_000)}\uD800`,
        },
        { type: 'inputText', text: `\uDC00${pair.repeat(40_000)}` },
      ],
      true,
    ],
  ];

  it.each(fixtures)(
    'joins to the synchronous output: %s',
    (_name, contentItems, success) => {
      const options = { contentItems, success };
      const chunks = Array.from(codexDynamicToolOutputChunks(options));
      expect(chunks.join('') === codexDynamicToolOutput(options)).toBe(true);
      for (const chunk of chunks)
        expect(chunk.length).toBeLessThanOrEqual(
          CODEX_TOOL_OUTPUT_CHUNK_MAX_CHARS,
        );
    },
  );
});
