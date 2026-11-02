import {
  DOCUMENT_PREVIEW_MAX_BYTES,
  VIDEO_PREVIEW_MAX_BYTES,
  documentPreviewMaxBytes,
} from '../index';

describe('documentPreviewMaxBytes', () => {
  it.each(['reel.mp4', '/w/OUT/Reel.MP4', 'a.m4v', 'c:\\clips\\b.webm'])(
    'gives %s the video budget',
    (path) => {
      expect(documentPreviewMaxBytes(path)).toBe(VIDEO_PREVIEW_MAX_BYTES);
    },
  );

  it('gives an authoritative video media type the video budget', () => {
    expect(documentPreviewMaxBytes('reel', 'video/mp4')).toBe(
      VIDEO_PREVIEW_MAX_BYTES,
    );
    expect(
      documentPreviewMaxBytes('reel', ' Video/MP4; codecs=avc1.42E01E '),
    ).toBe(VIDEO_PREVIEW_MAX_BYTES);
    expect(documentPreviewMaxBytes('clip', 'video/quicktime')).toBe(
      DOCUMENT_PREVIEW_MAX_BYTES,
    );
  });

  it.each(['brief.pdf', 'clip.mov', 'mp4', 'dir.mp4/brief.pdf', 'x.mp4.pdf'])(
    'keeps %s on the document budget',
    (path) => {
      expect(documentPreviewMaxBytes(path)).toBe(DOCUMENT_PREVIEW_MAX_BYTES);
    },
  );
});
