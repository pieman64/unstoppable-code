import {
  APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
  APPROVAL_CONTENT_PREVIEW_MAX_LINES,
  APPROVAL_MENU_TARGET_MAX_CHARS,
  previewApprovalContent,
  previewApprovalTargetLabel,
} from '../approval-content-preview';

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
