import {
  CLOUD_ATTACHMENT_FILENAME_MAX_BYTES,
  CLOUD_ATTACHMENT_MEDIA_TYPES,
  DOCX_MEDIA_TYPE,
  XLSX_MEDIA_TYPE,
  isCloudAttachmentFilename,
  isCloudAttachmentMediaType,
  isCloudImageAttachmentMediaType,
  mediaTypeForAttachmentFilename,
  normalizeCloudAttachmentFilenameStem,
  cloudAttachmentFilenameByteLength,
  truncateCloudAttachmentFilename,
} from '../index';

describe('isCloudAttachmentFilename', () => {
  it('checks the same normalized stem the desktop materializes', () => {
    expect(normalizeCloudAttachmentFilenameStem('COM1-')).toBe('com1');
    expect(isCloudAttachmentFilename('COM1-.txt')).toBe(false);
  });

  it.each(['photo.png', 'report.final.pdf', 'CONTEXT.txt'])(
    'accepts portable filename %s',
    (filename) => {
      expect(isCloudAttachmentFilename(filename)).toBe(true);
    },
  );

  it.each([
    '',
    '.',
    '..',
    '../photo.png',
    'folder/photo.png',
    'folder\\photo.png',
    'CON.txt',
    'COM1-.txt',
    'NUL.foo.bar',
    'report.txt.',
    'report.txt ',
    'bad:name.txt',
    'bad' + String.fromCharCode(127) + '.txt',
  ])('rejects non-portable filename %s', (filename) => {
    expect(isCloudAttachmentFilename(filename)).toBe(false);
  });

  it('enforces the portable 255-byte filesystem component limit', () => {
    expect(isCloudAttachmentFilename(`${'a'.repeat(251)}.txt`)).toBe(true);
    expect(isCloudAttachmentFilename(`${'a'.repeat(252)}.txt`)).toBe(false);
    expect(isCloudAttachmentFilename(`${'é'.repeat(125)}.txt`)).toBe(true);
    expect(isCloudAttachmentFilename(`${'é'.repeat(126)}.txt`)).toBe(false);
  });

  it('truncates at the byte boundary without dropping the extension', () => {
    const truncated = truncateCloudAttachmentFilename(`${'é'.repeat(600)}.pdf`);
    expect(truncated.endsWith('.pdf')).toBe(true);
    expect(cloudAttachmentFilenameByteLength(truncated)).toBeLessThanOrEqual(
      CLOUD_ATTACHMENT_FILENAME_MAX_BYTES,
    );
    expect(cloudAttachmentFilenameByteLength(`é${truncated}`)).toBeGreaterThan(
      CLOUD_ATTACHMENT_FILENAME_MAX_BYTES,
    );
  });
});

describe('cloud attachment media types', () => {
  it('names the OOXML types verbatim', () => {
    expect(DOCX_MEDIA_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(XLSX_MEDIA_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('allows docx and xlsx uploads (REG-2902)', () => {
    expect(CLOUD_ATTACHMENT_MEDIA_TYPES).toContain(DOCX_MEDIA_TYPE);
    expect(CLOUD_ATTACHMENT_MEDIA_TYPES).toContain(XLSX_MEDIA_TYPE);
    expect(isCloudAttachmentMediaType(DOCX_MEDIA_TYPE)).toBe(true);
    expect(isCloudAttachmentMediaType(XLSX_MEDIA_TYPE)).toBe(true);
    expect(isCloudImageAttachmentMediaType(DOCX_MEDIA_TYPE)).toBe(false);
  });

  it('keeps legacy Office, pptx, and macro variants download-only', () => {
    for (const mediaType of [
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-word.document.macroEnabled.12',
    ]) {
      expect(isCloudAttachmentMediaType(mediaType)).toBe(false);
    }
  });
});

describe('mediaTypeForAttachmentFilename', () => {
  it.each([
    ['photo.PNG', 'image/png'],
    ['scan.jpeg', 'image/jpeg'],
    ['scan.jpg', 'image/jpeg'],
    ['anim.gif', 'image/gif'],
    ['pic.webp', 'image/webp'],
    ['doc.pdf', 'application/pdf'],
    [
      'report.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    [
      'sheet.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    ['notes.txt', 'text/plain'],
    ['README.md', 'text/markdown'],
    ['data.csv', 'text/csv'],
    ['page.html', 'text/html'],
    ['config.json', 'application/json'],
  ])('maps %s to %s', (filename, expected) => {
    expect(mediaTypeForAttachmentFilename(filename)).toBe(expected);
  });

  it('returns null for unknown or missing extensions', () => {
    expect(mediaTypeForAttachmentFilename('archive.zip')).toBeNull();
    expect(mediaTypeForAttachmentFilename('Makefile')).toBeNull();
  });
});
