import {
  deleteRetentionTooltip,
  getWorkEntryBatchCopy,
  getWorkEntryRemovalLabels,
  WORK_ENTRY_BATCH_UNIT,
} from '../work-entry-removal-labels';

describe('getWorkEntryRemovalLabels', () => {
  it('reads the archive copy', () => {
    expect(getWorkEntryRemovalLabels('archive', 7)).toEqual({
      dialogConfirmLabel: 'Archive chat',
      dialogBody:
        'It leaves the sidebar with its messages and is kept until you delete it.',
      dialogDestructive: false,
      retentionSummary: 'Archived chats are kept until you delete them.',
      retentionDetail:
        'Archiving removes each chat from the sidebar and keeps its messages until you delete the archive. Restore it from Archived and deleted.',
    });
  });

  it('reads the delete copy with the retention window', () => {
    expect(getWorkEntryRemovalLabels('delete', 7)).toEqual({
      dialogConfirmLabel: 'Delete chat',
      dialogBody:
        'It leaves the sidebar with its messages and is removed after 7 days.',
      dialogDestructive: true,
      retentionSummary: 'Deleted chats are kept for 7 days, then removed.',
      retentionDetail:
        'Deleting removes each chat from the sidebar. Its messages are kept for 7 days in Archived and deleted, then removed.',
    });
    expect(getWorkEntryRemovalLabels('delete', 1).retentionSummary).toBe(
      'Deleted chats are kept for 1 day, then removed.',
    );
  });

  it('names a single day in the Delete tooltip', () => {
    expect(deleteRetentionTooltip(1)).toBe('Kept for 1 day, then removed');
    expect(deleteRetentionTooltip(30)).toBe('Kept for 30 days, then removed');
  });

  it('names chats in the batch unit', () => {
    expect(WORK_ENTRY_BATCH_UNIT).toEqual({
      singular: 'chat',
      plural: 'chats',
    });
  });
});

describe('getWorkEntryBatchCopy', () => {
  it('reads the single-window copy for one distinct window', () => {
    const single = getWorkEntryRemovalLabels('delete', 7);
    expect(getWorkEntryBatchCopy('delete', [7, 7])).toEqual({
      retentionSummary: single.retentionSummary,
      retentionDetail: single.retentionDetail,
    });
  });

  it('reads the mixed wording for several delete windows', () => {
    expect(getWorkEntryBatchCopy('delete', [7, 30])).toEqual({
      retentionSummary: "Restorable for each project's retention window.",
      retentionDetail:
        "Deleting removes each chat from the sidebar. Its messages are kept for its project's retention window in Archived and deleted, then removed.",
    });
  });

  it('never varies archive copy by window', () => {
    expect(getWorkEntryBatchCopy('archive', [7, 30]).retentionSummary).toBe(
      'Archived chats are kept until you delete them.',
    );
  });
});
