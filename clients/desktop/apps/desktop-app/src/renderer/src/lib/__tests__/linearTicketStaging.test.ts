/**
 * @jest-environment jsdom
 */
import { stageLinearTicketAttachment } from '../linearTicketStaging';
import { importChatAttachments } from '@/lib/chatAttachments';
import type { LinearTicketSearchResult } from '@canopy/desktop-shared/types';

jest.mock('@/lib/chatAttachments', () => ({
  importChatAttachments: jest.fn(),
}));

const importChatAttachmentsMock = jest.mocked(importChatAttachments);

class TestTextEncoder {
  encode(value: string): Uint8Array {
    return Uint8Array.from(
      Array.from(value, (char: string) => char.charCodeAt(0)),
    );
  }
}

Object.assign(globalThis, { TextEncoder: TestTextEncoder });

describe('stageLinearTicketAttachment', () => {
  const target = { projectId: 'project-1', worktreeId: 'worktree-1' };
  const ticket: LinearTicketSearchResult = {
    id: 'ticket-1',
    identifier: 'CAN-202',
    title: 'Fix the thing',
    description: 'Some ticket description.',
    url: 'https://linear.app/canopy/issue/CAN-202',
    priority: 2,
    priorityLabel: 'High',
    branchName: 'can-202-fix-the-thing',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('imports the ticket snapshot markdown as a clipboard attachment', async () => {
    importChatAttachmentsMock.mockResolvedValue([
      {
        filename: 'linear-can-202.md',
        absolutePath: '/tmp/worktree/.canopy/attachments/linear-can-202.md',
      },
    ]);
    const addPending = jest.fn();

    await stageLinearTicketAttachment(target, ticket, addPending);

    expect(importChatAttachmentsMock).toHaveBeenCalledTimes(1);
    const [calledTarget, filePaths, clipboardItems] =
      importChatAttachmentsMock.mock.calls[0];
    expect(calledTarget).toBe(target);
    expect(filePaths).toEqual([]);
    expect(clipboardItems).toHaveLength(1);
    expect(clipboardItems?.[0].filename).toBe('linear-can-202.md');

    const markdown = Buffer.from(clipboardItems?.[0].data ?? []).toString(
      'utf8',
    );
    expect(markdown).toContain('# CAN-202: Fix the thing');
    expect(markdown).toContain(
      '- URL: https://linear.app/canopy/issue/CAN-202',
    );
    expect(markdown).toContain('Some ticket description.');
  });

  it('marks imported results with the linear-ticket prompt kind before handing them to the sink', async () => {
    importChatAttachmentsMock.mockResolvedValue([
      {
        filename: 'linear-can-202.md',
        absolutePath: '/tmp/worktree/.canopy/attachments/linear-can-202.md',
      },
    ]);
    const addPending = jest.fn();

    await stageLinearTicketAttachment(target, ticket, addPending);

    expect(addPending).toHaveBeenCalledWith([
      {
        filename: 'linear-can-202.md',
        absolutePath: '/tmp/worktree/.canopy/attachments/linear-can-202.md',
        promptKind: 'linear-ticket',
      },
    ]);
  });

  it('awaits an async addPending sink', async () => {
    importChatAttachmentsMock.mockResolvedValue([]);
    let resolved = false;
    const addPending = jest.fn(async () => {
      await Promise.resolve();
      resolved = true;
    });

    await stageLinearTicketAttachment(target, ticket, addPending);

    expect(resolved).toBe(true);
  });
});
