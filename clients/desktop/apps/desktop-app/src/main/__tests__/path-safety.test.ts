import { isPathInside } from '../lib/path-safety';

describe('isPathInside', () => {
  it('treats the filesystem root as containing descendants', () => {
    expect(isPathInside('/', '/Users/example/.canopy')).toBe(true);
  });

  it('does not treat sibling prefixes as containment', () => {
    expect(isPathInside('/tmp/app', '/tmp/app-data')).toBe(false);
  });
});
