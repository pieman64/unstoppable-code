import { forceSvgFill, getFileIconDef, resolveFileIconName } from '../resolve';

describe('resolveFileIconName', () => {
  it('prefers exact filename matches', () => {
    expect(resolveFileIconName('/tmp/package.json')).toBe('npm');
  });

  it('matches compound extensions before shorter suffixes', () => {
    expect(resolveFileIconName('app.test.ts')).toBe('typescript');
    expect(resolveFileIconName('app.test.tsx')).toBe('react');
  });

  it('bridges extensions through the icon-category fallback map', () => {
    expect(resolveFileIconName('settings.toml')).toBe('config');
    expect(resolveFileIconName('local.env')).toBe('config');
  });

  it('uses the provided language when the filename has no useful extension', () => {
    expect(
      resolveFileIconName('artifact', { language: 'typescriptreact' }),
    ).toBe('react');
  });

  it('returns null when no mapping exists', () => {
    expect(resolveFileIconName('archive.unknownext')).toBeNull();
    expect(getFileIconDef('archive.unknownext')).toBeNull();
  });
});

describe('getFileIconDef', () => {
  it('returns the Seti registry entry for a resolved icon', () => {
    const def = getFileIconDef('main.ts');

    expect(def).not.toBeNull();
    expect(def?.viewBox).toMatch(/^\d+ \d+ \d+ \d+$/);
    expect(def?.paths.length).toBeGreaterThan(0);
  });

  it('uses markdown blue for special markdown filenames', () => {
    expect(resolveFileIconName('README.md')).toBe('info');
    expect(getFileIconDef('README.md')?.paths).toContain('fill="#529BBA"');

    expect(resolveFileIconName('TODO.md')).toBe('todo');
    expect(getFileIconDef('TODO.md')?.paths).toContain('fill="#529BBA"');

    expect(resolveFileIconName('CHANGELOG.md')).toBe('clock');
    expect(getFileIconDef('CHANGELOG.md')?.paths).toContain('fill="#529BBA"');

    expect(resolveFileIconName('changes.md')).toBe('clock');
    expect(getFileIconDef('changes.md')?.paths).toContain('fill="#529BBA"');

    expect(resolveFileIconName('version.md')).toBe('clock');
    expect(getFileIconDef('version.md')?.paths).toContain('fill="#529BBA"');
  });

  it('uses config gray for non-markdown special filenames', () => {
    expect(getFileIconDef('.editorconfig')?.paths).toContain('fill="#41535B"');
    expect(getFileIconDef('.prettierrc')?.paths).toContain('fill="#41535B"');
    expect(getFileIconDef('CHANGELOG.txt')?.paths).toContain('fill="#41535B"');
    expect(getFileIconDef('README.txt')?.paths).toContain('fill="#41535B"');
    expect(getFileIconDef('TODO.txt')?.paths).toContain('fill="#41535B"');
    expect(getFileIconDef('.babelrc')?.paths).toContain('fill="#41535B"');
    expect(getFileIconDef('vite.config.ts')?.paths).toContain('fill="#41535B"');
    expect(getFileIconDef('webpack.config.js')?.paths).toContain(
      'fill="#41535B"',
    );
    expect(getFileIconDef('webpack.config.js')?.paths).not.toContain('#231f20');
  });

  it('does not apply special filename gray to all clock icons', () => {
    expect(resolveFileIconName('scratch.tmp')).toBe('clock');
    expect(getFileIconDef('scratch.tmp')?.paths).not.toContain(
      'fill="#41535B"',
    );
  });

  it('recolors inline style fill declarations without consuming attributes', () => {
    expect(
      forceSvgFill(
        '<path style="fill:#171321" transform="matrix(1 0 0 1 0 0)"/>',
        '#41535B',
      ),
    ).toContain('style="fill:#41535B" transform="matrix(1 0 0 1 0 0)"');
  });

  it('recolors attribute-form fill and preserves non-rendering fills', () => {
    expect(forceSvgFill('<path fill="#171321"/>', '#529BBA')).toContain(
      'fill="#529BBA"',
    );
    expect(forceSvgFill('<path fill="none"/>', '#529BBA')).toContain(
      'fill="none"',
    );
    expect(forceSvgFill('<path fill="transparent"/>', '#529BBA')).toContain(
      'fill="transparent"',
    );
    expect(forceSvgFill('<path fill="url(#gradient)"/>', '#529BBA')).toContain(
      'fill="url(#gradient)"',
    );
  });

  it('preserves inline style fills for none, transparent, and gradients', () => {
    expect(forceSvgFill('<path style="fill:none"/>', '#529BBA')).toContain(
      'style="fill:none"',
    );
    expect(
      forceSvgFill('<path style="fill:transparent"/>', '#529BBA'),
    ).toContain('style="fill:transparent"');
    expect(
      forceSvgFill('<path style="fill:url(#gradient)"/>', '#529BBA'),
    ).toContain('style="fill:url(#gradient)"');
  });
});
