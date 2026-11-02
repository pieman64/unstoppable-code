import { previewCodexDynamicToolContent } from '../codex-dynamic-tool-results';

describe('previewCodexDynamicToolContent', () => {
  it('returns "Done" when no content items and success is true', () => {
    expect(
      previewCodexDynamicToolContent({ contentItems: [], success: true }),
    ).toBe('Done');
    expect(
      previewCodexDynamicToolContent({ contentItems: null, success: true }),
    ).toBe('Done');
    expect(
      previewCodexDynamicToolContent({
        contentItems: undefined,
        success: null,
      }),
    ).toBe('Done');
  });

  it('returns "Failed" when no content items and success is false', () => {
    expect(
      previewCodexDynamicToolContent({ contentItems: [], success: false }),
    ).toBe('Failed');
    expect(
      previewCodexDynamicToolContent({ contentItems: null, success: false }),
    ).toBe('Failed');
  });

  it('joins all inputText.text values with blank lines, preserving order', () => {
    const text = previewCodexDynamicToolContent({
      contentItems: [
        { type: 'inputText', text: 'first' },
        { type: 'inputText', text: 'second' },
        { type: 'inputText', text: 'third' },
      ],
      success: true,
    });

    expect(text).toBe('first\n\nsecond\n\nthird');
  });

  it('flattens inputImage entries to a placeholder', () => {
    const text = previewCodexDynamicToolContent({
      contentItems: [
        { type: 'inputText', text: 'before' },
        { type: 'inputImage', url: 'data:image/png;base64,XXXX' },
        { type: 'inputText', text: 'after' },
      ],
      success: true,
    });

    expect(text).toBe('before\n\n[image output omitted]\n\nafter');
  });

  it('reports omitted unknown output rather than implying nothing was returned', () => {
    expect(
      previewCodexDynamicToolContent({
        contentItems: [{ type: 'unknown' }, { type: 'other' }],
        success: true,
      }),
    ).toBe('[unsupported output omitted]\n\n[unsupported output omitted]');

    expect(
      previewCodexDynamicToolContent({
        contentItems: [{ type: 'unknown' }],
        success: false,
      }),
    ).toBe('[unsupported output omitted]');
  });

  it('returns empty-string placeholders when an inputText has no text field', () => {
    const text = previewCodexDynamicToolContent({
      contentItems: [
        { type: 'inputText' },
        { type: 'inputText', text: 'present' },
      ],
      success: true,
    });

    expect(text).toBe('\n\npresent');
  });

  it('marks an individually oversized text item as truncated', () => {
    const text = previewCodexDynamicToolContent({
      contentItems: [{ type: 'inputText', text: 'x'.repeat(64 * 1024 + 1) }],
      success: true,
    });

    expect(text.length).toBeLessThanOrEqual(64 * 1024);
    expect(text.endsWith('[additional output omitted]')).toBe(true);
  });

  it('reports content items omitted by the item-count limit', () => {
    const text = previewCodexDynamicToolContent({
      contentItems: Array.from({ length: 250 }, (_, index) => ({
        type: 'inputText',
        text: `item-${String(index)}`,
      })),
      success: true,
    });

    expect(text).toContain('[150 additional content items omitted]');
  });
});
