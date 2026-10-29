import { sanitizeDownloadName, uniqueDownloadName } from '../download-name';

describe('sanitizeDownloadName', () => {
  it.each([
    ['', 'download'],
    ['.', 'download'],
    ['..', 'download'],
    ['...   ', 'download'],
    ['   ', 'download'],
    ['\0', 'download'],
    ['<>:"|?*', 'download'],
    ['report.pdf', 'report.pdf'],
    ['Quarterly report (final).PDF', 'Quarterly report (final).PDF'],
    ['résumé-日本語-😀.txt', 'résumé-日本語-😀.txt'],
    ['.env', '.env'],
    ['archive.tar.gz', 'archive.tar.gz'],
    ['  report.txt', '  report.txt'],
    ['report.txt...   ', 'report.txt'],
    ['re\0port.pdf', 'report.pdf'],
    ['a<b>c:d"e|f?g*h.txt', 'abcdefgh.txt'],
    ['re\u0001\u001f\u007f\u0085port\n\t.pdf', 'report.pdf'],
    ['CON.txt... ', '_CON.txt'],
    ['CON .txt', '_CON .txt'],
  ])('sanitizes %j to %j', (input, expected) => {
    expect(sanitizeDownloadName(input)).toBe(expected);
  });

  it.each([
    ['../../secret.txt', 'secret.txt'],
    ['..\\..\\secret.txt', 'secret.txt'],
    ['C:\\Users\\Alice\\Downloads\\report.pdf', 'report.pdf'],
    ['\\\\server\\share\\report.pdf', 'report.pdf'],
    ['/tmp/a\\b/report.pdf', 'report.pdf'],
    ['folder\0/report.pdf', 'report.pdf'],
    ['folder/', 'download'],
    ['folder\\', 'download'],
    ['folder/.', 'download'],
    ['folder/..', 'download'],
    ['%2e%2e%2fsecret.txt', '%2e%2e%2fsecret.txt'],
  ])(
    'keeps only a literal cross-platform basename of %j',
    (input, expected) => {
      expect(sanitizeDownloadName(input)).toBe(expected);
    },
  );

  const devices = [
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'con',
    'aUx',
    'CONIN$',
    'CONOUT$',
    ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
    ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
    'COM¹',
    'COM²',
    'COM³',
    'LPT¹',
    'LPT²',
    'LPT³',
  ];

  it.each(devices)(
    'prefixes reserved device %s with and without extensions',
    (device) => {
      expect(sanitizeDownloadName(device)).toBe(`_${device}`);
      expect(sanitizeDownloadName(`${device}.txt`)).toBe(`_${device}.txt`);
      expect(sanitizeDownloadName(`${device}.tar.gz`)).toBe(
        `_${device}.tar.gz`,
      );
    },
  );

  it.each([
    'COM0.txt',
    'COM10.txt',
    'LPT0',
    'LPT10',
    'CONSOLE.txt',
    'auxiliary',
    '_NUL.txt',
  ])('preserves non-device name %s', (name) => {
    expect(sanitizeDownloadName(name)).toBe(name);
  });

  it('preserves names exactly at the 200-byte boundary', () => {
    const name = `${'a'.repeat(196)}.pdf`;
    expect(sanitizeDownloadName(name)).toBe(name);
    expect(Buffer.byteLength(name, 'utf8')).toBe(200);
  });

  it('caps ASCII stems and preserves the last extension', () => {
    expect(sanitizeDownloadName(`${'a'.repeat(300)}.pdf`)).toBe(
      `${'a'.repeat(196)}.pdf`,
    );
    expect(sanitizeDownloadName('a'.repeat(300))).toBe('a'.repeat(200));
    expect(sanitizeDownloadName(`${'a'.repeat(300)}.tar.gz`)).toBe(
      `${'a'.repeat(197)}.gz`,
    );
  });

  it.each([
    ['é', 98],
    ['界', 65],
    ['😀', 49],
  ])(
    'truncates %s only at complete Unicode code points',
    (character, count) => {
      const name = sanitizeDownloadName(`${character.repeat(300)}.pdf`);
      expect(name).toBe(`${character.repeat(count)}.pdf`);
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(200);
      expect(Buffer.from(name, 'utf8').toString('utf8')).toBe(name);
    },
  );

  it('caps long dotfiles without treating the leading dot as an extension', () => {
    expect(sanitizeDownloadName(`.${'a'.repeat(300)}`)).toBe(
      `.${'a'.repeat(199)}`,
    );
  });

  it('truncates an oversized extension only when it cannot fit with a stem', () => {
    expect(sanitizeDownloadName(`x.${'é'.repeat(150)}`)).toBe(
      `x.${'é'.repeat(99)}`,
    );
  });

  it('does not expose a reserved device stem when a huge extension consumes the budget', () => {
    const name = sanitizeDownloadName(`CONsole.${'x'.repeat(196)}`);
    expect(name).toBe(`_CO.${'x'.repeat(196)}`);
    expect(Buffer.byteLength(name, 'utf8')).toBe(200);
  });

  it('removes trailing spaces newly exposed by truncation', () => {
    expect(sanitizeDownloadName(`${'a'.repeat(199)} ${'b'.repeat(50)}`)).toBe(
      'a'.repeat(199),
    );
  });

  it('is safe and idempotent across adversarial basename and Unicode inputs', () => {
    const inputs = [
      '',
      '..',
      '../CON.txt',
      'NUL...',
      'a<>:b.txt',
      '.env',
      '😀'.repeat(300),
      `CONsole.${'x'.repeat(196)}`,
      `x.${'界'.repeat(300)}`,
    ];
    for (const input of inputs) {
      const name = sanitizeDownloadName(input);
      expect(name).not.toBe('');
      // eslint-disable-next-line no-control-regex
      expect(name).not.toMatch(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/);
      expect(name).not.toMatch(/[ .]$/);
      expect(name).not.toBe('.');
      expect(name).not.toBe('..');
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(200);
      expect(sanitizeDownloadName(name)).toBe(name);
    }
  });
});

describe('uniqueDownloadName', () => {
  it('sanitizes before looking for a collision', () => {
    expect(uniqueDownloadName('../a?.txt', new Set())).toBe('a.txt');
    expect(uniqueDownloadName('../a?.txt', new Set(['a.txt']))).toBe(
      'a (1).txt',
    );
    expect(uniqueDownloadName('CON.txt', new Set(['_con.txt']))).toBe(
      '_CON (1).txt',
    );
  });

  it('returns a free name unchanged without mutating occupied names', () => {
    const occupied = new Set(['other.txt']);
    expect(uniqueDownloadName('report.txt', occupied)).toBe('report.txt');
    expect(Array.from(occupied)).toEqual(['other.txt']);
  });

  it('matches occupied names case-insensitively including Unicode', () => {
    expect(
      uniqueDownloadName(
        'Report.PDF',
        new Set(['REPORT.pdf', 'report (1).PDF']),
      ),
    ).toBe('Report (2).PDF');
    expect(uniqueDownloadName('Été.txt', new Set(['ÉTÉ.TXT']))).toBe(
      'Été (1).txt',
    );
  });

  it('chooses the first available positive integer rather than counting occupied names', () => {
    expect(
      uniqueDownloadName(
        'file.txt',
        new Set(['file.txt', 'file (1).txt', 'file (3).txt']),
      ),
    ).toBe('file (2).txt');
  });

  it.each([
    ['download', 'download (1)'],
    ['', 'download (1)'],
    ['file', 'file (1)'],
    ['.env', '.env (1)'],
    ['archive.tar.gz', 'archive.tar (1).gz'],
    ['file (1).pdf', 'file (1) (1).pdf'],
  ])(
    'inserts the suffix before the final extension of %j',
    (input, expected) => {
      expect(
        uniqueDownloadName(input, new Set([sanitizeDownloadName(input)])),
      ).toBe(expected);
    },
  );

  it('reserves suffix bytes and rechecks collisions after truncating the stem', () => {
    const original = `${'a'.repeat(196)}.pdf`;
    const occupied = new Set([original, `${'a'.repeat(192)} (1).pdf`]);
    const result = uniqueDownloadName(`${'a'.repeat(300)}.pdf`, occupied);
    expect(result).toBe(`${'a'.repeat(192)} (2).pdf`);
    expect(Buffer.byteLength(result, 'utf8')).toBe(200);
  });

  it('accounts for growth from single-digit to double-digit suffixes', () => {
    const occupied = new Set([
      `${'a'.repeat(196)}.pdf`,
      ...Array.from(
        { length: 9 },
        (_, index) => `${'a'.repeat(192)} (${index + 1}).pdf`,
      ),
    ]);
    expect(uniqueDownloadName(`${'a'.repeat(196)}.pdf`, occupied)).toBe(
      `${'a'.repeat(191)} (10).pdf`,
    );
  });

  it('keeps Unicode stems whole when reserving suffix bytes', () => {
    const input = `${'😀'.repeat(80)}.pdf`;
    const result = uniqueDownloadName(
      input,
      new Set([sanitizeDownloadName(input)]),
    );
    expect(result).toBe(`${'😀'.repeat(48)} (1).pdf`);
    expect(Buffer.byteLength(result, 'utf8')).toBe(200);
  });

  it('retains a suffix even when an oversized extension must also be truncated', () => {
    const input = `x.${'é'.repeat(150)}`;
    const result = uniqueDownloadName(
      input,
      new Set([sanitizeDownloadName(input)]),
    );
    expect(result).toBe(`x (1).${'é'.repeat(97)}`);
    expect(Buffer.byteLength(result, 'utf8')).toBe(200);
    expect(sanitizeDownloadName(result)).toBe(result);
  });

  it('skips a name the caller reports as taken, as well as the occupied ones', () => {
    const onDisk = new Set(['report.csv', 'report (2).csv']);
    expect(
      uniqueDownloadName('report.csv', new Set(['report (1).csv']), (name) =>
        onDisk.has(name),
      ),
    ).toBe('report (3).csv');
  });
});
