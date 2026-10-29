import {
  fileExtension,
  fileRenderKindForMediaType,
  isRichDocumentRenderKind,
  resolveFileRenderKind,
} from '../file-kind';

describe('fileExtension', () => {
  it('lower-cases the extension', () => {
    expect(fileExtension('src/App.TSX')).toBe('tsx');
  });

  it('ignores query/hash suffixes', () => {
    expect(fileExtension('docs/readme.md?raw=1')).toBe('md');
    expect(fileExtension('a/b.html#top')).toBe('html');
  });

  it('returns empty for a dotfile or extensionless path', () => {
    expect(fileExtension('.gitignore')).toBe('');
    expect(fileExtension('Makefile')).toBe('');
  });
});

describe('resolveFileRenderKind', () => {
  it('picks markdown by extension', () => {
    expect(resolveFileRenderKind({ path: 'a/b.md' })).toBe('markdown');
    expect(resolveFileRenderKind({ path: 'a/b.mdx' })).toBe('markdown');
  });

  it('picks html by extension', () => {
    expect(resolveFileRenderKind({ path: 'a/index.htm' })).toBe('html');
  });

  it.each(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'])(
    'picks the historical desktop image kind for .%s',
    (extension) => {
      expect(resolveFileRenderKind({ path: `assets/image.${extension}` })).toBe(
        'image',
      );
    },
  );

  it.each(['document.pdf', 'document.PDF', 'document.pdf?download=1'])(
    'picks the PDF document kind for %s',
    (path) => {
      expect(resolveFileRenderKind({ path })).toBe('pdf');
    },
  );

  it('falls back to the language hint when the extension is unknown', () => {
    expect(
      resolveFileRenderKind({ path: 'a/notes', language: 'markdown' }),
    ).toBe('markdown');
  });

  it('defaults to code for anything else', () => {
    expect(
      resolveFileRenderKind({ path: 'src/a.ts', language: 'typescript' }),
    ).toBe('code');
  });
});

describe('office render kinds (REG-2902)', () => {
  it.each(['report.docx', 'REPORT.DOCX', 'a/b/report.docx?x=1'])(
    'picks docx for %s',
    (path) => {
      expect(resolveFileRenderKind({ path })).toBe('docx');
    },
  );

  it.each(['data.xlsx', 'DATA.XLSX'])('picks xlsx for %s', (path) => {
    expect(resolveFileRenderKind({ path })).toBe('xlsx');
  });

  it.each(['deck.pptx', 'DECK.PPTX', 'a/b/deck.pptx#slide=2'])(
    'picks pptx for %s',
    (path) => {
      expect(resolveFileRenderKind({ path })).toBe('pptx');
    },
  );

  it('leaves legacy and macro-enabled Office extensions on the code path', () => {
    for (const path of [
      'old.doc',
      'old.xls',
      'old.ppt',
      'macro.docm',
      'macro.xlsm',
      'macro.pptm',
    ]) {
      expect(resolveFileRenderKind({ path })).toBe('code');
    }
  });

  it('classifies rich document kinds', () => {
    expect(isRichDocumentRenderKind('pdf')).toBe(true);
    expect(isRichDocumentRenderKind('docx')).toBe(true);
    expect(isRichDocumentRenderKind('xlsx')).toBe(true);
    expect(isRichDocumentRenderKind('pptx')).toBe(true);
    expect(isRichDocumentRenderKind('image')).toBe(false);
    expect(isRichDocumentRenderKind('code')).toBe(false);
  });

  it('maps authoritative attachment media types to render kinds', () => {
    expect(fileRenderKindForMediaType('application/pdf')).toBe('pdf');
    expect(
      fileRenderKindForMediaType(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe('docx');
    expect(
      fileRenderKindForMediaType(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe('xlsx');
    expect(
      fileRenderKindForMediaType(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
    ).toBe('pptx');
    expect(fileRenderKindForMediaType('text/plain')).toBeUndefined();
    expect(
      fileRenderKindForMediaType('application/vnd.ms-excel'),
    ).toBeUndefined();
    expect(fileRenderKindForMediaType(undefined)).toBeUndefined();
  });
});
