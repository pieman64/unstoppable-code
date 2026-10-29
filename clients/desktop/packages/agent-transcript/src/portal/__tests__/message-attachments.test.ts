import {
  portalChatAttachmentIdForPath,
  portalChatMessageAttachmentsFromPaths,
} from '../message-attachments';

describe('portalChatMessageAttachmentsFromPaths', () => {
  it('projects basename, media type, and a stable path-derived id', () => {
    const [attachment] = portalChatMessageAttachmentsFromPaths([
      '/Users/me/.canopy/workspaces/w/attachments/t/photo.PNG',
    ]);
    expect(attachment).toEqual({
      attachmentId: portalChatAttachmentIdForPath(
        '/Users/me/.canopy/workspaces/w/attachments/t/photo.PNG',
      ),
      filename: 'photo.PNG',
      mediaType: 'image/png',
    });
    expect(attachment?.attachmentId).toMatch(/^path-[0-9a-f]{8}$/);
  });

  it('handles Windows separators and unknown extensions', () => {
    expect(
      portalChatMessageAttachmentsFromPaths([
        'C:\\data\\attachments\\dump.bin',
      ]),
    ).toEqual([
      {
        attachmentId: portalChatAttachmentIdForPath(
          'C:\\data\\attachments\\dump.bin',
        ),
        filename: 'dump.bin',
        mediaType: 'application/octet-stream',
      },
    ]);
  });

  it('drops empty entries and de-duplicates identical paths', () => {
    expect(
      portalChatMessageAttachmentsFromPaths(['', '/a/b.txt', '/a/b.txt']),
    ).toHaveLength(1);
  });

  it('is deterministic across calls', () => {
    expect(portalChatAttachmentIdForPath('/x/y.md')).toBe(
      portalChatAttachmentIdForPath('/x/y.md'),
    );
    expect(portalChatAttachmentIdForPath('/x/y.md')).not.toBe(
      portalChatAttachmentIdForPath('/x/z.md'),
    );
  });
});
