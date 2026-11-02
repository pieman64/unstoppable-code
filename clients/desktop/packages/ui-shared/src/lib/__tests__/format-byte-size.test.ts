import { formatByteSize } from '../format-byte-size';

describe('formatByteSize', (): void => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1229, '1.2 KB'],
    [1024 ** 2, '1.0 MB'],
    [3.4 * 1024 ** 2, '3.4 MB'],
    [1024 ** 3, '1.0 GB'],
    [-1, '0 B'],
    [NaN, '0 B'],
    [Infinity, '0 B'],
    [-Infinity, '0 B'],
  ])('formats %s as %s', (bytes, expected): void => {
    expect(formatByteSize(bytes)).toBe(expected);
  });
});

describe('formatByteSize adaptive precision', (): void => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [10 * 1024 + 700, '11 KB'],
    [3 * 1024 ** 2, '3 MB'],
    [2.25 * 1024 ** 3, '2.3 GB'],
    [2 * 1024 ** 4, '2 TB'],
    [-5, '0 B'],
    [NaN, '0 B'],
  ])('formats %s as %s', (bytes, expected): void => {
    expect(formatByteSize(bytes, { precision: 'adaptive' })).toBe(expected);
  });
});
