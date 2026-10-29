import { estimateTranscriptWindowBytes } from '../../transcript-storage';

describe('transcript storage metrics', () => {
  it('estimates a loaded window from durable descriptor metadata in constant time', () => {
    expect(
      estimateTranscriptWindowBytes(
        {
          committedByteLength: 20_000,
          committedMessageCount: 100,
        },
        25,
      ),
    ).toBe(5_000);
    expect(
      estimateTranscriptWindowBytes(
        {
          committedByteLength: 20_000,
          committedMessageCount: 100,
        },
        0,
      ),
    ).toBe(0);
  });
});
