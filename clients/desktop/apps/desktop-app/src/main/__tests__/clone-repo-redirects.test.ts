/**
 * Command-construction test for the external-install redirect defense (portal
 * PR B1 round-2). Asserts the exact `git` argv placement of
 * `-c http.followRedirects=false` — before the `clone` subcommand, the only
 * position git honors a config override — so a redirect into a private host
 * cannot bypass the initial-URL SSRF allowlist.
 */
import { buildCloneRepoArgs } from '../lib/git';

describe('buildCloneRepoArgs', () => {
  const url = 'https://github.com/acme/reviewer.git';
  const dest = '/cache/reviewer-abcd';

  it('disables redirects with the config placed before `clone`', () => {
    expect(buildCloneRepoArgs(url, dest, false)).toEqual([
      '-c',
      'http.followRedirects=false',
      'clone',
      '--',
      url,
      dest,
    ]);
  });

  it('follows redirects by default (no config flag) for trusted callers', () => {
    expect(buildCloneRepoArgs(url, dest, true)).toEqual([
      'clone',
      '--',
      url,
      dest,
    ]);
  });

  it('keeps `--` before the url so a hostile url cannot be read as a flag', () => {
    const args = buildCloneRepoArgs('--upload-pack=evil', dest, false);
    expect(args.indexOf('--')).toBeLessThan(args.indexOf('--upload-pack=evil'));
    // The config override still precedes the subcommand.
    expect(args.slice(0, 3)).toEqual([
      '-c',
      'http.followRedirects=false',
      'clone',
    ]);
  });
});
