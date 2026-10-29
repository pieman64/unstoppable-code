import {
  CLOUD_ATTACHMENT_FILENAME_MAX_BYTES,
  CLOUD_ATTACHMENTS_MAX_PER_MESSAGE,
} from '../cloud-attachments';
import {
  PORTAL_CAPABILITY_CHAT_ATTACHMENTS,
  PORTAL_CAPABILITY_CHAT_ASSETS,
  PORTAL_CAPABILITY_CHAT_CREATE_TAB_SETTINGS,
  PORTAL_CAPABILITY_STANDALONE_CHAT_CREATE,
  PORTAL_COMMAND_TYPES_SET,
  PORTAL_SMALL_RPC_COMMAND_TYPES,
  portalChatMessageAttachmentsFromRefs,
  readPortalChatMessageAttachments,
  type PortalChatCloudAttachmentRef,
} from '../portal';

const REF: PortalChatCloudAttachmentRef = {
  attachmentId: '11111111-1111-4111-8111-111111111111',
  filename: 'screenshot.png',
  mediaType: 'image/png',
  size: 2048,
  contentSha256: 'a'.repeat(64),
  storageKind: 'blob',
  source: 'https://core.example/attachments/1/content',
};

describe('readPortalChatMessageAttachments', () => {
  it('keeps only the display fields of well-formed items', () => {
    expect(
      readPortalChatMessageAttachments([
        { ...REF, kind: 'user-image', extra: true },
      ]),
    ).toEqual([
      {
        attachmentId: REF.attachmentId,
        filename: 'screenshot.png',
        mediaType: 'image/png',
        size: 2048,
      },
    ]);
  });

  it('drops malformed items and returns undefined when nothing survives', () => {
    expect(
      readPortalChatMessageAttachments([
        { attachmentId: 'x', filename: '', mediaType: 'image/png', size: 1 },
        { attachmentId: 'y', filename: 'f', mediaType: 'image/png', size: -1 },
        { filename: 'f', mediaType: 'image/png', size: 1 },
        null,
        'nope',
      ]),
    ).toBeUndefined();
    expect(readPortalChatMessageAttachments(undefined)).toBeUndefined();
    expect(readPortalChatMessageAttachments({})).toBeUndefined();
  });
});

describe('portalChatMessageAttachmentsFromRefs', () => {
  it('strips the composer-only fields from ready refs', () => {
    expect(portalChatMessageAttachmentsFromRefs([REF])).toEqual([
      {
        attachmentId: REF.attachmentId,
        filename: 'screenshot.png',
        mediaType: 'image/png',
        size: 2048,
      },
    ]);
  });
});

describe('attachment validation and ordering', () => {
  it('keeps the first valid item for each id in original order', () => {
    const result = readPortalChatMessageAttachments([
      { ...REF, filename: '' },
      REF,
      { ...REF, filename: 'duplicate.png' },
      { ...REF, attachmentId: 'second', size: 0 },
    ]);
    expect(
      result?.map(({ attachmentId, filename, size }) => ({
        attachmentId,
        filename,
        size,
      })),
    ).toEqual([
      {
        attachmentId: REF.attachmentId,
        filename: REF.filename,
        size: REF.size,
      },
      { attachmentId: 'second', filename: REF.filename, size: 0 },
    ]);
  });
  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid size %s',
    (size) => {
      expect(
        readPortalChatMessageAttachments([{ ...REF, size }]),
      ).toBeUndefined();
    },
  );
  it.each(['attachmentId', 'filename', 'mediaType'])(
    'rejects a blank %s',
    (key) => {
      expect(
        readPortalChatMessageAttachments([{ ...REF, [key]: '  ' }]),
      ).toBeUndefined();
    },
  );
});

describe('attachment caps', () => {
  it('drops an item whose filename exceeds the max length', () => {
    const tooLong = {
      ...REF,
      attachmentId: 'too-long',
      filename: 'x'.repeat(CLOUD_ATTACHMENT_FILENAME_MAX_BYTES + 1),
    };
    expect(readPortalChatMessageAttachments([tooLong])).toBeUndefined();
    expect(readPortalChatMessageAttachments([tooLong, REF])).toEqual([
      {
        attachmentId: REF.attachmentId,
        filename: REF.filename,
        mediaType: REF.mediaType,
        size: REF.size,
      },
    ]);
  });

  it('accepts a filename exactly at the max length', () => {
    const atMax = {
      ...REF,
      filename: 'x'.repeat(CLOUD_ATTACHMENT_FILENAME_MAX_BYTES),
    };
    expect(readPortalChatMessageAttachments([atMax])).toEqual([
      {
        attachmentId: atMax.attachmentId,
        filename: atMax.filename,
        mediaType: atMax.mediaType,
        size: atMax.size,
      },
    ]);
  });

  it('stops collecting after the per-message cap of well-formed items', () => {
    const items = Array.from(
      { length: CLOUD_ATTACHMENTS_MAX_PER_MESSAGE + 3 },
      (_, index) => ({ ...REF, attachmentId: `att-${index}` }),
    );
    const result = readPortalChatMessageAttachments(items);
    expect(result).toHaveLength(CLOUD_ATTACHMENTS_MAX_PER_MESSAGE);
    expect(result?.map((item) => item.attachmentId)).toEqual(
      items
        .slice(0, CLOUD_ATTACHMENTS_MAX_PER_MESSAGE)
        .map((item) => item.attachmentId),
    );
  });
});

describe('chat attachment capability', () => {
  it('is the frozen wire name desktops announce', () => {
    expect(PORTAL_CAPABILITY_CHAT_ATTACHMENTS).toBe('chat_attachments');
    expect(PORTAL_CAPABILITY_CHAT_ASSETS).toBe('chat_assets_v1');
    expect(PORTAL_CAPABILITY_STANDALONE_CHAT_CREATE).toBe(
      'standalone_chat_create',
    );
    expect(PORTAL_CAPABILITY_CHAT_CREATE_TAB_SETTINGS).toBe(
      'chat_create_tab_settings',
    );
    for (const command of [
      'portal.chat.asset.read',
      'portal.file.asset.read',
      'portal.chat.create_tab',
      'portal.standalone_chat.create',
    ] as const) {
      expect(PORTAL_COMMAND_TYPES_SET.has(command)).toBe(true);
      expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has(command)).toBe(true);
    }
  });
});

describe('readPortalChatMessageAttachments without size', () => {
  it('accepts a display ref that omits size (desktop-local files)', () => {
    expect(
      readPortalChatMessageAttachments([
        {
          attachmentId: 'path-1',
          filename: 'notes.md',
          mediaType: 'text/markdown',
        },
      ]),
    ).toEqual([
      {
        attachmentId: 'path-1',
        filename: 'notes.md',
        mediaType: 'text/markdown',
      },
    ]);
  });

  it('still rejects a present but malformed size', () => {
    expect(
      readPortalChatMessageAttachments([
        {
          attachmentId: 'path-1',
          filename: 'a.png',
          mediaType: 'image/png',
          size: -1,
        },
      ]),
    ).toBeUndefined();
  });
});
