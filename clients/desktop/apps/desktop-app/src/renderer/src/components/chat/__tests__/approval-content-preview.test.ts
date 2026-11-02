import {
  APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
  APPROVAL_CONTENT_PREVIEW_MAX_LINES,
  APPROVAL_MENU_TARGET_MAX_CHARS,
  approvalAnnouncementText,
  previewApprovalContent,
  previewApprovalTargetLabel,
} from '../approval-content-preview';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';

describe('previewApprovalContent', () => {
  it('returns short content untouched', () => {
    expect(previewApprovalContent('npm test')).toEqual({
      text: 'npm test',
      truncated: false,
    });
  });

  it('keeps content that sits exactly at the line limit', () => {
    const lines = Array.from(
      { length: APPROVAL_CONTENT_PREVIEW_MAX_LINES },
      (_, i) => `echo ${i}`,
    );
    const content = lines.join('\n');
    expect(previewApprovalContent(content)).toEqual({
      text: content,
      truncated: false,
    });
  });

  it('truncates to the line limit and marks the preview truncated', () => {
    const lines = Array.from(
      { length: APPROVAL_CONTENT_PREVIEW_MAX_LINES + 20 },
      (_, i) => `echo ${i}`,
    );
    const result = previewApprovalContent(lines.join('\n'));
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(
      lines.slice(0, APPROVAL_CONTENT_PREVIEW_MAX_LINES).join('\n'),
    );
  });

  it('truncates a single very long line to the character limit', () => {
    const content = 'x'.repeat(APPROVAL_CONTENT_PREVIEW_MAX_CHARS + 100);
    const result = previewApprovalContent(content);
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
  });
});

describe('previewApprovalTargetLabel', () => {
  it('returns a short single-line label untouched', () => {
    expect(previewApprovalTargetLabel('npm test *')).toEqual({
      text: 'npm test *',
      truncated: false,
    });
  });

  it('keeps only the first line of a multi-line target', () => {
    const result = previewApprovalTargetLabel('python3 -c "\nimport os\n"');
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('python3 -c "');
  });

  it('caps a long single-line target at the menu character limit', () => {
    const label = 'y'.repeat(APPROVAL_MENU_TARGET_MAX_CHARS + 30);
    const result = previewApprovalTargetLabel(label);
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(APPROVAL_MENU_TARGET_MAX_CHARS);
  });
});

describe('approvalAnnouncementText', () => {
  function pending(
    details: ApprovalRequestEvent['details'],
    title = 'Run command',
  ): ApprovalRequestEvent {
    return {
      requestId: 'req-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      provider: 'claude',
      title,
      details,
    };
  }

  it('names the title and the command on one bounded line', () => {
    const text = approvalAnnouncementText(
      pending({ kind: 'command', command: `${'x'.repeat(200)}\nsecond line` }),
    );
    expect(text).toBe(
      `Approval needed: Run command. ${'x'.repeat(APPROVAL_MENU_TARGET_MAX_CHARS)}…`,
    );
  });

  it('bounds a multiline or oversized title as well as its context', () => {
    const text = approvalAnnouncementText(
      pending({ kind: 'tool', toolName: 'Read' }, `${'t'.repeat(200)}\nsecret`),
    );
    expect(text).toBe(
      `Approval needed: ${'t'.repeat(APPROVAL_MENU_TARGET_MAX_CHARS)}…. Read`,
    );
    expect(text).not.toContain('secret');
  });

  it('prefers the projected path for a file write', () => {
    expect(
      approvalAnnouncementText(
        pending(
          {
            kind: 'file-write',
            path: '/repo/src/index.ts',
            displayPath: 'src/index.ts',
          },
          'Edit file',
        ),
      ),
    ).toBe('Approval needed: Edit file. src/index.ts');
  });
});
