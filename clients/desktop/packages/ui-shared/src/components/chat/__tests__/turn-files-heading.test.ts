import { formatTurnFilesHeading } from '../turn-files-heading';

const saved = {};
const updated = { change: 'updated' } as const;
const updating = { change: 'updated', pending: true } as const;
const creating = { pending: true };

describe('formatTurnFilesHeading', () => {
  it('shows nothing for zero displayed files', () => {
    expect(formatTurnFilesHeading([])).toBeUndefined();
    expect(formatTurnFilesHeading([], { other: true })).toBeUndefined();
  });

  it('keeps saved-only wording unchanged', () => {
    expect(formatTurnFilesHeading([saved])).toBe('1 file');
    expect(formatTurnFilesHeading([saved, saved])).toBe('2 files');
    expect(formatTurnFilesHeading([creating])).toBe('1 file');
  });

  it('names updated-only files', () => {
    expect(formatTurnFilesHeading([updated])).toBe('1 file updated');
    expect(formatTurnFilesHeading([updated, updated, updated])).toBe(
      '3 files updated',
    );
  });

  it('counts updates within a mixed total', () => {
    expect(formatTurnFilesHeading([saved, updated])).toBe('2 files, 1 updated');
    expect(formatTurnFilesHeading([saved, updated, updated])).toBe(
      '3 files, 2 updated',
    );
  });

  it('never claims pending updates are complete', () => {
    expect(formatTurnFilesHeading([updating])).toBe('1 file updating');
    expect(formatTurnFilesHeading([updating, updating])).toBe(
      '2 files updating',
    );
    // A neutral total until pending work settles.
    expect(formatTurnFilesHeading([updating, updated])).toBe('2 files');
    expect(formatTurnFilesHeading([updating, creating])).toBe('2 files');
    expect(formatTurnFilesHeading([updated, creating])).toBe('2 files');
  });

  it('words files beside a turn diff as other files', () => {
    expect(formatTurnFilesHeading([saved], { other: true })).toBe(
      '1 other file',
    );
    expect(formatTurnFilesHeading([updated], { other: true })).toBe(
      '1 other file updated',
    );
    expect(formatTurnFilesHeading([updated, updated], { other: true })).toBe(
      '2 other files updated',
    );
    expect(formatTurnFilesHeading([saved, updated], { other: true })).toBe(
      '2 other files, 1 updated',
    );
    expect(formatTurnFilesHeading([updating], { other: true })).toBe(
      '1 other file updating',
    );
  });
});

describe('formatTurnFilesHeading while approval is pending (CAN-5291)', () => {
  const waiting = { change: 'updated', pending: true, waiting: true } as const;

  it('keeps a neutral total while any change waits', () => {
    expect(formatTurnFilesHeading([waiting])).toBe('1 file');
    expect(formatTurnFilesHeading([waiting, updating])).toBe('2 files');
    expect(formatTurnFilesHeading([waiting], { other: true })).toBe(
      '1 other file',
    );
  });

  it('says updating again once approval clears', () => {
    expect(formatTurnFilesHeading([{ ...waiting, waiting: false }])).toBe(
      '1 file updating',
    );
  });
});
