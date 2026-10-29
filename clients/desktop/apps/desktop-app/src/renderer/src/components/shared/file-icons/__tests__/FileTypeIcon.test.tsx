import { renderToString } from 'react-dom/server';
import { FileTypeIcon } from '../FileTypeIcon';

jest.mock('../resolve', () => ({ getFileIconDef: (): undefined => undefined }));

describe('FileTypeIcon fallback', () => {
  it('keeps an accessible name when a generic file uses the shared glyph', () => {
    const html = renderToString(
      <FileTypeIcon
        filename="document.unrecognized-file-kind"
        title="Document file"
      />,
    );
    expect(html).toContain('role="img"');
    const accessibleName =
      html.match(/aria-label="([^"]+)"/)?.[1] ??
      html.match(/<title[^>]*>([^<]*)<\/title>/)?.[1];
    expect(accessibleName).toBe('Document file');
    expect(html).not.toContain('aria-hidden="true"');
  });

  it('keeps an unnamed generic file decorative', () => {
    const html = renderToString(
      <FileTypeIcon filename="document.unrecognized-file-kind" />,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
  });
});
