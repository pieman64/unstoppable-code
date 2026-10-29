/** @jest-environment jsdom */
import {
  DOCX_PREVIEW_MAX_ELEMENTS,
  DocxElementBudgetError,
  buildDocxPreviewSrcDoc,
  sanitizeDocxHtml,
} from '../docx-sanitize';

describe('sanitizeDocxHtml', () => {
  it('preserves text and markup above the removed admission caps', () => {
    const text = 'x'.repeat(256 * 1024 + 1);
    const paragraphs = '<p>x</p>'.repeat(1001);
    expect(sanitizeDocxHtml(text)).toBe(text);
    expect(sanitizeDocxHtml(paragraphs)).toBe(paragraphs);
    expect(DOCX_PREVIEW_MAX_ELEMENTS).toBe(200_000);
  });

  it('strips non-numeric table spans while preserving numeric spans', () => {
    const output = sanitizeDocxHtml(
      '<table><tr><td colspan="invalid" rowspan="2">one</td><td colspan="3" rowspan="2x">two</td></tr></table>',
    );
    expect(output).not.toContain('colspan="invalid"');
    expect(output).not.toContain('rowspan="2x"');
    expect(output).toContain('rowspan="2"');
    expect(output).toContain('colspan="3"');
  });

  const hostile =
    '<h1>Title</h1><script>window.x=1</script>' +
    '<a href="javascript:alert(1)">bad</a><a href="https://example.com/x">external</a>' +
    '<a href="//example.com/x">relative</a><a href="mailto:a@example.com">mail</a>' +
    '<a href="#section">bookmark</a>' +
    '<img src="data:image/png;base64,AAAA" onerror="alert(1)">' +
    '<img src="https://example.com/tracker.png"><img src="data:image/svg+xml;base64,PHN2Zz4=">' +
    '<p style="color:red" onclick="x()">t</p><iframe src="https://evil.invalid"></iframe>' +
    '<table><tr><td colspan="2">cell</td></tr></table><ul><li>item</li></ul>';

  it('removes active content, styling, event handlers, and unsafe image sources', () => {
    const output = sanitizeDocxHtml(hostile);
    expect(output).not.toContain('<script');
    expect(output).not.toContain('javascript:');
    expect(output).not.toContain('onerror');
    expect(output).not.toContain('onclick');
    expect(output).not.toContain('style=');
    expect(output).not.toContain('<iframe');
    expect(output).not.toContain('tracker.png');
    expect(output).not.toContain('image/svg+xml');
  });

  it('keeps semantic structure, a bounded raster data image, and only bookmark links', () => {
    const output = sanitizeDocxHtml(hostile);
    expect(output).toContain('<h1>Title</h1>');
    expect(output).toContain('<img src="data:image/png;base64,AAAA">');
    expect(output).toContain('<a>bad</a>');
    expect(output).toContain('<a>external</a>');
    expect(output).toContain('<a>relative</a>');
    expect(output).toContain('<a>mail</a>');
    expect(output).toContain('<a href="#section">bookmark</a>');
    expect(output).toContain('<td colspan="2">cell</td>');
    expect(output).toContain('<li>item</li>');
  });

  it('removes malformed and empty raster data sources', () => {
    const output = sanitizeDocxHtml(
      '<img alt="empty" src="data:image/png;base64,">' +
        '<img alt="bad" src="data:image/png;base64,abc">',
    );
    expect(output).toContain('<img alt="empty">');
    expect(output).toContain('<img alt="bad">');
    expect(output).not.toContain('src=');
  });

  it('preserves a raster image at the established 4 MiB decoded limit', () => {
    const image = Buffer.alloc(4 * 1024 * 1024).toString('base64');
    const html = `<p>before</p><img alt="large" src="data:image/png;base64,${image}"><p>after</p>`;
    expect(sanitizeDocxHtml(html)).toBe(html);
  });

  it('strips an oversized image source while preserving the document', () => {
    const image = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
    expect(
      sanitizeDocxHtml(
        `<p>before</p><img alt="large" src="data:image/png;base64,${image}"><p>after</p>`,
      ),
    ).toBe('<p>before</p><img alt="large"><p>after</p>');
  });

  it('accepts exactly the element budget', () => {
    expect(() =>
      sanitizeDocxHtml('<br>'.repeat(DOCX_PREVIEW_MAX_ELEMENTS)),
    ).not.toThrow();
  });

  it('rejects one element beyond the element budget', () => {
    expect(() =>
      sanitizeDocxHtml('<br>'.repeat(DOCX_PREVIEW_MAX_ELEMENTS + 1)),
    ).toThrow(DocxElementBudgetError);
  });

  it('counts forbidden elements before removing them', () => {
    const html = '<br>'.repeat(DOCX_PREVIEW_MAX_ELEMENTS) + '<script></script>';
    expect(() => sanitizeDocxHtml(html)).toThrow(DocxElementBudgetError);
  });
});

describe('buildDocxPreviewSrcDoc', () => {
  it('wraps sanitized markup in a script-free opaque-origin document', () => {
    const srcDoc = buildDocxPreviewSrcDoc('<p>hi</p>');
    expect(srcDoc.startsWith('<!doctype html>')).toBe(true);
    expect(srcDoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcDoc).toContain("script-src 'none'");
    expect(srcDoc).toContain('<style>');
    expect(srcDoc.endsWith('<p>hi</p>')).toBe(true);
  });
});
