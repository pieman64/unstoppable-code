import {
  HTML_FILE_PREVIEW_CSP,
  buildSandboxedHtmlSrcDoc,
} from '../sandboxed-html';

describe('buildSandboxedHtmlSrcDoc', () => {
  it('prepends a doctype and the preview CSP meta tag', () => {
    const doc = buildSandboxedHtmlSrcDoc('<p>hi</p>');
    expect(
      doc.startsWith(
        '<!doctype html>\n<meta http-equiv="Content-Security-Policy"',
      ),
    ).toBe(true);
    expect(doc).toContain(`content="${HTML_FILE_PREVIEW_CSP}"`);
    expect(doc.endsWith('<p>hi</p>')).toBe(true);
  });

  it('strips a leading doctype and meta refresh redirects', () => {
    const doc = buildSandboxedHtmlSrcDoc(
      '<!DOCTYPE html><meta http-equiv="refresh" content="0;url=https://evil.example"><p>x</p>',
    );
    expect(doc.match(/<!doctype/gi)).toHaveLength(1);
    expect(doc).not.toContain('refresh');
    expect(doc).toContain('<p>x</p>');
  });

  it('keeps the CSP with scripts, connections, frames, and workers disabled', () => {
    expect(HTML_FILE_PREVIEW_CSP).toContain("script-src 'none'");
    expect(HTML_FILE_PREVIEW_CSP).toContain("connect-src 'none'");
    expect(HTML_FILE_PREVIEW_CSP).toContain("frame-src 'none'");
    expect(HTML_FILE_PREVIEW_CSP).toContain("worker-src 'none'");
  });
});
