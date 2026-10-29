import { linuxUpdateCopy } from '../lib/linux-update-copy';

describe('Linux manual update copy and official destination', () => {
  it('uses brand names and Linux recovery, never macOS or Windows recovery', () => {
    const copy = linuxUpdateCopy({ displayName: 'Example' });
    expect(copy.manual).toContain('Example');
    expect(copy.unsupported).toContain('x64 or arm64 .deb');
    expect(copy.unavailable).toContain('connection');
    expect(copy.unavailable).toContain('this architecture');
    expect(copy.verification).toContain('matching your installed architecture');
    expect(copy.verification).toMatch(/Verify.*checksum/);
    expect(Object.values(copy).join(' ')).not.toMatch(
      /macOS|Applications folder|DMG|File Explorer|sudo|pkexec/,
    );
  });
});
