import { linuxUpdateCopy } from '../lib/linux-update-copy';

describe('Linux manual update copy and official destination', () => {
  it('uses brand names and Linux recovery, never macOS or Windows recovery', () => {
    const copy = linuxUpdateCopy({ displayName: 'Example' });
    expect(copy.manual).toContain('Example');
    expect(copy.unsupported).toContain('.deb or pacman package');
    expect(copy.unsupported).toContain('x64 or arm64');
    expect(copy.packageManager).toMatch(/package manager:$/);
    expect(copy.unavailable).toContain('connection');
    expect(copy.unavailable).toContain('this architecture');
    expect(copy.verification).toContain('matching your installed architecture');
    expect(copy.verification).toMatch(/Verify.*checksum/);
    expect(
      Object.values(copy)
        .filter((value): value is string => typeof value === 'string')
        .join(' '),
    ).not.toMatch(/macOS|Applications folder|DMG|File Explorer|sudo|pkexec/);
  });
});

describe('published APT suite guidance', () => {
  const published = { id: 'unstoppable-code', displayName: 'Example' };
  it('offers APT and one-time bootstrap only for the published stable brand', () => {
    const copy = linuxUpdateCopy(published, 'stable');
    expect(copy.manual).toContain('sudo apt update && sudo apt upgrade');
    expect(copy.manual).toContain(
      'install the current official .deb once more',
    );
    expect(copy.downloadLabel).toBe('Reinstall Linux package');
    expect(copy.apt?.command).toBe('sudo apt update && sudo apt upgrade');
    expect(copy.verification).toMatch(/reinstall fallback/);
    expect(copy.verification).toMatch(/Verify.*checksum/);
  });
  it.each(['internal', 'rc', 'dev', 'unknown'] as const)(
    'keeps %s on direct downloads',
    (flavor) => {
      const copy = linuxUpdateCopy(published, flavor);
      expect(
        Object.values(copy)
          .filter((value): value is string => typeof value === 'string')
          .join(' '),
      ).not.toMatch(/apt update|APT|once more/);
      expect(copy.manual).toContain('manually');
    },
  );
  it('keeps unpublished brands on direct downloads', () => {
    expect(
      linuxUpdateCopy({ id: 'canopy', displayName: 'Example' }, 'stable')
        .manual,
    ).not.toContain('apt');
    expect(linuxUpdateCopy({ displayName: 'Example' }).manual).not.toContain(
      'apt',
    );
  });
});
