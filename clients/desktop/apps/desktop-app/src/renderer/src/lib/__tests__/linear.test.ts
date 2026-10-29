import type { LinearTicketSearchResult } from '@canopy/desktop-shared/types';
import {
  buildLinearTicketSnapshotMarkdown,
  linearSnapshotFilename,
  markLinearTicketAttachment,
} from '../linear';

function makeTicket(
  overrides: Partial<LinearTicketSearchResult> = {},
): LinearTicketSearchResult {
  return {
    id: 'ticket-1',
    identifier: 'CAN-202',
    title: 'Add Linear ticket attachments',
    description: 'Wire up the snapshot markdown flow.',
    url: 'https://linear.app/canopy/issue/CAN-202',
    priority: 2,
    priorityLabel: 'High',
    branchName: 'tommy/can-202-linear-ticket-attachments',
    ...overrides,
  };
}

describe('buildLinearTicketSnapshotMarkdown', () => {
  it('renders identifier, title, metadata, and description', () => {
    const markdown = buildLinearTicketSnapshotMarkdown(makeTicket());

    expect(markdown).toBe(
      [
        '# CAN-202: Add Linear ticket attachments',
        '',
        '- URL: https://linear.app/canopy/issue/CAN-202',
        '- Priority: High',
        '- Suggested branch: tommy/can-202-linear-ticket-attachments',
        '',
        '## Description',
        '',
        'Wire up the snapshot markdown flow.',
      ].join('\n'),
    );
  });

  it('falls back to a placeholder when the description is null', () => {
    const markdown = buildLinearTicketSnapshotMarkdown(
      makeTicket({ description: null }),
    );

    expect(markdown).toContain('## Description');
    expect(markdown.trimEnd().endsWith('_No description provided._')).toBe(
      true,
    );
  });
});

describe('linearSnapshotFilename', () => {
  it('sanitizes the identifier into a lowercase markdown filename', () => {
    expect(linearSnapshotFilename(makeTicket({ identifier: 'CAN-202' }))).toBe(
      'linear-can-202.md',
    );
  });

  it('strips characters outside [a-z0-9-] from the identifier', () => {
    expect(
      linearSnapshotFilename(makeTicket({ identifier: 'CAN 202/foo!' })),
    ).toBe('linear-can202foo.md');
  });
});

describe('markLinearTicketAttachment', () => {
  it('marks the attachment with the linear-ticket prompt kind', () => {
    const attachment = markLinearTicketAttachment({
      filename: 'linear-can-202.md',
      absolutePath: '/tmp/attachments/linear-can-202.md',
    });

    expect(attachment).toEqual({
      filename: 'linear-can-202.md',
      absolutePath: '/tmp/attachments/linear-can-202.md',
      promptKind: 'linear-ticket',
    });
  });
});
