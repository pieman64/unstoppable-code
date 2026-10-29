import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  assertPrivateDirectoryAcl,
  broadAllowEntries,
  readWindowsDirectorySddl,
  renameWithRetry,
  WINDOWS_RENAME_ATTEMPTS,
} from '../private-storage';

const USER_ONLY =
  'O:S-1-5-21-1-2-3-1001G:S-1-5-21-1-2-3-513D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;S-1-5-21-1-2-3-1001)';

describe('broadAllowEntries', () => {
  it('accepts a DACL granting only SYSTEM, Administrators and the owner', () => {
    expect(broadAllowEntries(USER_ONLY)).toEqual([]);
  });

  it('finds allow entries for broad principals by alias or SID', () => {
    expect(
      broadAllowEntries(
        'D:AI(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;;FR;;;S-1-1-0)(A;ID;FR;;;S-1-5-11)',
      ),
    ).toEqual([
      'A;OICIID;0x1200a9;;;BU',
      'A;;FR;;;S-1-1-0',
      'A;ID;FR;;;S-1-5-11',
    ]);
  });

  it('ignores deny entries and entries in the SACL', () => {
    expect(
      broadAllowEntries('D:P(D;OICI;FA;;;WD)(A;OICI;FA;;;SY)S:(AU;SA;FA;;;WD)'),
    ).toEqual([]);
  });

  it('treats callback allow entries as grants, including nested conditions', () => {
    expect(
      broadAllowEntries(
        'D:P(A;OICI;FA;;;SY)(XA;OICI;FA;;;WD;((@User.Project Any_of {"a", "b"}) && (Member_of {SID(BA)})))(ZA;;FR;;;S-1-5-32-545;(Exists x))',
      ),
    ).toEqual([
      'XA;OICI;FA;;;WD;((@User.Project Any_of {"a", "b"}) && (Member_of {SID(BA)}))',
      'ZA;;FR;;;S-1-5-32-545;(Exists x)',
    ]);
    expect(broadAllowEntries('D:(XD;;FA;;;WD;(Exists x))(A;;FA;;;SY)')).toEqual(
      [],
    );
  });

  it('treats a null DACL as granting everyone access', () => {
    expect(broadAllowEntries('D:NO_ACCESS_CONTROLS:(AU;SA;FA;;;WD)')).toEqual([
      'NO_ACCESS_CONTROL',
    ]);
  });

  it('fails closed for a descriptor it cannot parse', () => {
    for (const sddl of [
      '',
      'O:SYG:SY',
      'D:(A;;FA;;;SY',
      'D:(A;;FA;;;SY)junk',
      'D:(A;;FA;SY)',
    ])
      expect(() => broadAllowEntries(sddl)).toThrow(
        'Unreadable Windows security descriptor',
      );
  });
});

describe('assertPrivateDirectoryAcl', () => {
  it('is a no-op on POSIX, where mode bits are checked instead', async () => {
    const readSddl = jest.fn();
    await assertPrivateDirectoryAcl('/tmp/x', { platform: 'darwin', readSddl });
    expect(readSddl).not.toHaveBeenCalled();
  });

  it('rejects a Windows directory that grants Users, and accepts a private one', async () => {
    await expect(
      assertPrivateDirectoryAcl('C:\\data\\shared', {
        platform: 'win32',
        readSddl: () => Promise.resolve('D:AI(A;OICI;FA;;;SY)(A;OICI;FR;;;BU)'),
      }),
    ).rejects.toThrow('not private');
    const readSddl = jest.fn(() => Promise.resolve(USER_ONLY));
    await assertPrivateDirectoryAcl('C:\\data\\private', {
      platform: 'win32',
      readSddl,
    });
    await assertPrivateDirectoryAcl('C:\\DATA\\Private', {
      platform: 'win32',
      readSddl,
    });
    expect(readSddl).toHaveBeenCalledTimes(1);
  });
});

describe('renameWithRetry', () => {
  const failure = (code: string): Error =>
    Object.assign(new Error(code), { code });

  it('retries transient Windows lock errors, then succeeds', async () => {
    const rename = jest
      .fn<Promise<void>, [string, string]>()
      .mockRejectedValueOnce(failure('EPERM'))
      .mockRejectedValueOnce(failure('EBUSY'))
      .mockResolvedValueOnce(undefined);
    await renameWithRetry('a', 'b', 5, rename);
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it('waits out a Windows lock held for more than a second', async () => {
    // A scanner or concurrent reader held a freshly committed delegation
    // record for longer than the former half-second window in the VM.
    jest.useFakeTimers();
    try {
      const lockedUntil = Date.now() + 1_500;
      const rename = jest.fn<Promise<void>, [string, string]>(() =>
        Date.now() < lockedUntil
          ? Promise.reject(failure('EPERM'))
          : Promise.resolve(),
      );
      const done = renameWithRetry('a', 'b', WINDOWS_RENAME_ATTEMPTS, rename);
      await jest.advanceTimersByTimeAsync(2_500);
      await expect(done).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('gives up after the bound and never retries other errors', async () => {
    const locked = jest
      .fn<Promise<void>, [string, string]>()
      .mockRejectedValue(failure('EACCES'));
    await expect(renameWithRetry('a', 'b', 2, locked)).rejects.toThrow(
      'EACCES',
    );
    expect(locked).toHaveBeenCalledTimes(2);
    const missing = jest
      .fn<Promise<void>, [string, string]>()
      .mockRejectedValue(failure('ENOENT'));
    await expect(renameWithRetry('a', 'b', 5, missing)).rejects.toThrow(
      'ENOENT',
    );
    expect(missing).toHaveBeenCalledTimes(1);
  });
});

const onWindows = process.platform === 'win32' ? it : it.skip;
onWindows('reads a real Windows DACL and detects a broad grant', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'delegation-private-'),
  );
  try {
    expect(
      broadAllowEntries(await readWindowsDirectorySddl(directory)),
    ).toEqual([]);
    await promisify(execFile)(
      path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'icacls.exe',
      ),
      [directory, '/grant', '*S-1-5-32-545:(R)'],
      { timeout: 10_000 },
    );
    expect(
      broadAllowEntries(await readWindowsDirectorySddl(directory)).length,
    ).toBeGreaterThan(0);
    await expect(assertPrivateDirectoryAcl(directory)).rejects.toThrow(
      'not private',
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
