import { resolutionTuple } from '../resolve/resolution-change-keys';

describe('W3 dependency key encoding', () => {
  it('does not conflate opaque identity, colons, separators or Unicode tuples', () => {
    expect(resolutionTuple(['a:b', 'c'])).not.toEqual(
      resolutionTuple(['a', 'b:c']),
    );
    expect(resolutionTuple(['x\\y', 'α'])).not.toEqual(
      resolutionTuple(['x', 'y:α']),
    );
    expect(JSON.parse(resolutionTuple(['', '漢字', 'C:\\repo']))).toEqual([
      '',
      '漢字',
      'C:\\repo',
    ]);
  });
});
