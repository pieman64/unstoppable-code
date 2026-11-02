import {
  TOOL_OUTPUT_INLINE_BYTES,
  TOOL_OUTPUT_PREVIEW_HEAD_BYTES,
} from '../../transcript-storage';
import { delegationLivePreview } from '../delegation-live-preview';

const MARKER = '\n[Preview: full text is kept when this item finishes]\n';
const TAIL_BYTES =
  TOOL_OUTPUT_INLINE_BYTES - TOOL_OUTPUT_PREVIEW_HEAD_BYTES - MARKER.length;

function expectSafePreview(text: string): string {
  const preview = delegationLivePreview(text);
  expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(
    TOOL_OUTPUT_INLINE_BYTES,
  );
  expect(preview).toContain(MARKER);
  expect(preview).not.toContain('[Full output stored separately]');
  // Roundtrip would replace any edge's split surrogate with U+FFFD.
  expect(Buffer.from(preview, 'utf8').toString('utf8')).toBe(preview);
  return preview;
}

describe('delegationLivePreview', () => {
  it('uses code-unit bounds without scanning short text or the middle of huge text', () => {
    const points = jest.spyOn(String.prototype, 'codePointAt');
    const units = jest.spyOn(String.prototype, 'charCodeAt');
    let shortReads = 0;
    let largeReads = 0;
    let largerReads = 0;
    try {
      delegationLivePreview('short');
      shortReads = points.mock.calls.length + units.mock.calls.length;
      points.mockClear();
      units.mockClear();
      delegationLivePreview('x'.repeat(TOOL_OUTPUT_INLINE_BYTES * 8));
      largeReads = points.mock.calls.length + units.mock.calls.length;
      points.mockClear();
      units.mockClear();
      delegationLivePreview('x'.repeat(TOOL_OUTPUT_INLINE_BYTES * 16));
      largerReads = points.mock.calls.length + units.mock.calls.length;
    } finally {
      points.mockRestore();
      units.mockRestore();
    }
    expect(shortReads).toBe(0);
    expect(largeReads).toBeGreaterThan(0);
    expect(largerReads).toBe(largeReads);
    expect(largerReads).toBeLessThan(TOOL_OUTPUT_INLINE_BYTES * 2);
  });

  it.each([
    '',
    'small',
    'x'.repeat(TOOL_OUTPUT_INLINE_BYTES),
    'é'.repeat(TOOL_OUTPUT_INLINE_BYTES / 2),
    '😀'.repeat(TOOL_OUTPUT_INLINE_BYTES / 4),
  ])('keeps within-budget text unchanged (case %#)', (text) => {
    expect(delegationLivePreview(text)).toBe(text);
  });

  it('fills the ASCII head and remaining tail byte budgets', () => {
    const whole =
      'h'.repeat(TOOL_OUTPUT_PREVIEW_HEAD_BYTES) +
      'omitted'.repeat(10_000) +
      't'.repeat(TAIL_BYTES);
    expect(expectSafePreview(whole)).toBe(
      'h'.repeat(TOOL_OUTPUT_PREVIEW_HEAD_BYTES) +
        MARKER +
        't'.repeat(TAIL_BYTES),
    );
  });

  it('bounds multibyte text by bytes rather than code units', () => {
    const whole = '界'.repeat(TOOL_OUTPUT_INLINE_BYTES / 2);
    expect(expectSafePreview(whole)).toBe(
      '界'.repeat(Math.floor(TOOL_OUTPUT_PREVIEW_HEAD_BYTES / 3)) +
        MARKER +
        '界'.repeat(Math.floor(TAIL_BYTES / 3)),
    );
  });

  it('counts the ambiguous code-unit range before deciding to preview', () => {
    const whole = 'é'.repeat(TOOL_OUTPUT_INLINE_BYTES / 2 + 1);
    expectSafePreview(whole);
  });

  it('does not split a surrogate pair at the head edge', () => {
    const head = 'h'.repeat(TOOL_OUTPUT_PREVIEW_HEAD_BYTES - 1);
    const whole = head + '😀' + 'x'.repeat(TOOL_OUTPUT_INLINE_BYTES);
    expect(expectSafePreview(whole)).toBe(
      head + MARKER + 'x'.repeat(TAIL_BYTES + 1),
    );
  });

  it('does not split a surrogate pair at the tail edge', () => {
    const tail = 't'.repeat(TAIL_BYTES - 1);
    const whole = 'h'.repeat(TOOL_OUTPUT_INLINE_BYTES) + '😀' + tail;
    expect(expectSafePreview(whole)).toBe(
      'h'.repeat(TOOL_OUTPUT_PREVIEW_HEAD_BYTES) + MARKER + tail,
    );
  });

  it('keeps complete supplementary code points at both edges when they fit', () => {
    const whole = '😀'.repeat(TOOL_OUTPUT_INLINE_BYTES);
    expect(expectSafePreview(whole)).toBe(
      '😀'.repeat(TOOL_OUTPUT_PREVIEW_HEAD_BYTES / 4) +
        MARKER +
        '😀'.repeat(Math.floor(TAIL_BYTES / 4)),
    );
  });
});
