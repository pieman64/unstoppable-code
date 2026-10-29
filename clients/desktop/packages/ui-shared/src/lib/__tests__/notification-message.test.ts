import {
  NOTIFICATION_PREVIEW_CHARS,
  NOTIFICATION_PREVIEW_LINES,
  previewNotificationMessage,
  previewToastMessage,
  summarizeCommandFailure,
  TOAST_PREVIEW_CHARS,
} from '../notification-message';

const HEADER =
  'Command failed while creating the binturong worktree from develop.';

/** A worktree-create failure shaped like the real ~7.8 KB git output. */
function buildWorktreeFailurePayload(separator: string): string {
  const lines = [
    HEADER,
    "Preparing worktree (new branch 'binturong-1791357289421')",
  ];
  let index = 0;
  while (lines.join(separator).length < 7800) {
    lines.push(`Updating files:  ${index % 100}% (${index}/400)`);
    lines.push(
      `error: unable to create file src/generated/file-${index}.ts: No space left on device`,
    );
    index += 1;
  }
  return lines.join(separator);
}

describe('previewNotificationMessage', (): void => {
  it('exports the default preview bounds', (): void => {
    expect(NOTIFICATION_PREVIEW_CHARS).toBe(240);
    expect(NOTIFICATION_PREVIEW_LINES).toBe(4);
  });

  it('returns a short message whole', (): void => {
    expect(previewNotificationMessage('Saved.')).toEqual({
      text: 'Saved.',
      truncated: false,
    });
  });

  it('keeps a message of exactly four lines whole', (): void => {
    const message = 'a\nb\nc\nd';
    expect(previewNotificationMessage(message)).toEqual({
      text: message,
      truncated: false,
    });
  });

  it('cuts a long message with an ellipsis', (): void => {
    const long = `First line\n${'x'.repeat(400)}`;
    const preview = previewNotificationMessage(long);
    expect(preview.truncated).toBe(true);
    expect(preview.text).toContain('First line');
    expect(preview.text.endsWith('…')).toBe(true);
    expect(preview.text).not.toContain('x'.repeat(400));
    expect(preview.text.length).toBeLessThanOrEqual(
      NOTIFICATION_PREVIEW_CHARS + 1,
    );
  });

  it('keeps only the first four lines', (): void => {
    const preview = previewNotificationMessage('1\n2\n3\n4\n5\n6');
    expect(preview).toEqual({ text: '1\n2\n3\n4…', truncated: true });
  });

  it('honors a custom line limit', (): void => {
    const preview = previewNotificationMessage('1\n2\n3', { maxLines: 2 });
    expect(preview).toEqual({ text: '1\n2…', truncated: true });
  });

  it('honors a custom character limit', (): void => {
    const preview = previewNotificationMessage('abcdefghij', { maxChars: 4 });
    expect(preview).toEqual({ text: 'abcd…', truncated: true });
  });

  it('trims trailing whitespace before the ellipsis', (): void => {
    const preview = previewNotificationMessage('one   \ntwo', { maxLines: 1 });
    expect(preview).toEqual({ text: 'one…', truncated: true });
  });
});

describe('previewToastMessage', (): void => {
  it('keeps three lines', (): void => {
    expect(previewToastMessage('1\n2\n3\n4')).toEqual({
      text: '1\n2\n3…',
      truncated: true,
    });
  });

  it('cuts a message longer than three lines of text', (): void => {
    const preview = previewToastMessage('x'.repeat(200));
    expect(preview).toEqual({
      text: `${'x'.repeat(TOAST_PREVIEW_CHARS)}…`,
      truncated: true,
    });
  });
});

describe('summarizeCommandFailure', (): void => {
  const expectedSummary = `${HEADER}\nunable to create file src/generated/file-`;

  it.each([
    ['\\n', '\n'],
    ['\\r', '\r'],
    ['\\r\\n', '\r\n'],
  ])(
    'keeps the first line and the last cause for a %s payload',
    (_label, separator): void => {
      const payload = buildWorktreeFailurePayload(separator);
      expect(payload.length).toBeGreaterThanOrEqual(7800);

      const result = summarizeCommandFailure(payload);

      expect(result.truncated).toBe(true);
      expect(result.summary.startsWith(expectedSummary)).toBe(true);
      expect(result.summary.endsWith(': No space left on device')).toBe(true);
      expect(result.summary).not.toContain('Updating files:');
      expect(result.summary).not.toContain('error:');
      expect(result.summary.split('\n')).toHaveLength(2);
      expect(result.summary.length).toBeLessThanOrEqual(
        NOTIFICATION_PREVIEW_CHARS,
      );
    },
  );

  it('summarizes the \\n and \\r payloads identically', (): void => {
    expect(summarizeCommandFailure(buildWorktreeFailurePayload('\n'))).toEqual(
      summarizeCommandFailure(buildWorktreeFailurePayload('\r')),
    );
  });

  it('keeps only the first line when no line names a cause', (): void => {
    expect(
      summarizeCommandFailure('Something broke.\nprogress 1\nprogress 2'),
    ).toEqual({ summary: 'Something broke.', truncated: true });
  });

  it('uses a fatal: line as the cause', (): void => {
    expect(
      summarizeCommandFailure(
        'Command failed.\nfatal: not a git repository\nhint: run git init',
      ),
    ).toEqual({
      summary: 'Command failed.\nnot a git repository',
      truncated: true,
    });
  });

  it('passes a single-line message through unchanged', (): void => {
    expect(summarizeCommandFailure('Failed to create worktree')).toEqual({
      summary: 'Failed to create worktree',
      truncated: false,
    });
  });

  it('does not report a CRLF two-line message as truncated', (): void => {
    expect(
      summarizeCommandFailure('Command failed.\r\nerror: disk is full'),
    ).toEqual({ summary: 'Command failed.\ndisk is full', truncated: false });
    expect(summarizeCommandFailure('Only line.\r\n')).toEqual({
      summary: 'Only line.',
      truncated: false,
    });
  });

  it('reports a dropped second line as truncated', (): void => {
    expect(summarizeCommandFailure('First line.\r\nSecond line.')).toEqual({
      summary: 'First line.',
      truncated: true,
    });
  });

  it('does not duplicate an error: line that is also the first line', (): void => {
    expect(summarizeCommandFailure('error: disk is full')).toEqual({
      summary: 'error: disk is full',
      truncated: false,
    });
    expect(summarizeCommandFailure('error: disk is full\nmore output')).toEqual(
      { summary: 'error: disk is full', truncated: true },
    );
  });

  it('cuts a first line longer than the preview limit', (): void => {
    const result = summarizeCommandFailure('y'.repeat(300));
    expect(result.truncated).toBe(true);
    expect(result.summary).toBe(`${'y'.repeat(NOTIFICATION_PREVIEW_CHARS)}…`);
  });

  it.each(['', '   ', '\n\r\n  \r'])(
    'returns an empty summary for blank input %j',
    (message): void => {
      expect(summarizeCommandFailure(message)).toEqual({
        summary: '',
        truncated: false,
      });
    },
  );
});
