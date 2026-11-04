import { pdfExternalLinks } from '../pdf-links';

describe('PDF link annotations', () => {
  it('keeps safe user-clicked links and rejects executable, local and malformed destinations', () => {
    const annotation = { subtype: 'Link', rect: [10, 20, 110, 40] };
    expect(
      pdfExternalLinks([
        { ...annotation, url: 'https://example.com/report' },
        { ...annotation, url: 'mailto:reader@example.com' },
        { ...annotation, url: 'javascript:alert(1)' },
        { ...annotation, url: 'file:///etc/passwd' },
        { ...annotation, url: 'data:text/html,test' },
        { ...annotation, unsafeUrl: 'https://example.com/unsafe' },
        { ...annotation, url: 'https://example.com', rect: [0, NaN, 1, 2] },
        { ...annotation, subtype: 'Widget', url: 'https://example.com' },
        null,
      ]),
    ).toEqual([
      { url: 'https://example.com/report', rect: [10, 20, 110, 40] },
      { url: 'mailto:reader@example.com', rect: [10, 20, 110, 40] },
    ]);
  });
});
