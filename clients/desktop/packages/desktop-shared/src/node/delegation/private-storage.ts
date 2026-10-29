import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

/** Well-known broad principals, as SDDL aliases and SID strings. A private
 * delegation directory must not grant any of them access. SIDs make the check
 * independent of the Windows display language. */
const BROAD_PRINCIPALS = new Set([
  'WD', // Everyone
  'S-1-1-0',
  'AN', // Anonymous
  'S-1-5-7',
  'IU', // Interactive
  'S-1-5-4',
  'AU', // Authenticated Users
  'S-1-5-11',
  'BU', // BUILTIN\Users
  'S-1-5-32-545',
  'BG', // BUILTIN\Guests
  'S-1-5-32-546',
]);

/** Allow ACE types: plain, object, callback and callback object. A callback
 * (conditional) allow still grants its trustee access when its condition holds. */
const ALLOW_TYPES = new Set(['A', 'OA', 'XA', 'ZA']);

/** Owner and group (a two-letter alias or a SID string), then the DACL tag and
 * its flags, which end at the first ACE, the SACL, or the end of the string. */
const DACL_HEADER =
  /^(?:O:(?:S-[0-9-]+|[A-Z]{2}))?(?:G:(?:S-[0-9-]+|[A-Z]{2}))?D:([A-Z_]*?)(?=\(|S:|$)/;

function malformed(): Error {
  return new Error('Unreadable Windows security descriptor');
}

/** The DACL's top-level ACE strings. Conditional ACEs nest parentheses in
 * their condition, so each ACE ends at its matching closing parenthesis. */
function daclEntries(sddl: string): { flags: string; entries: string[] } {
  const header = DACL_HEADER.exec(sddl);
  if (!header) throw malformed();
  const entries: string[] = [];
  let index = header[0].length;
  while (sddl[index] === '(') {
    let depth = 0;
    let end = index;
    for (; end < sddl.length; end += 1) {
      if (sddl[end] === '(') depth += 1;
      else if (sddl[end] === ')' && --depth === 0) break;
    }
    if (depth !== 0) throw malformed();
    entries.push(sddl.slice(index + 1, end));
    index = end + 1;
  }
  if (index !== sddl.length && !sddl.startsWith('S:', index)) throw malformed();
  return { flags: header[1], entries };
}

/** DACL entries in an SDDL string that grant a broad principal access. A null
 * DACL (`NO_ACCESS_CONTROL`) grants everyone access. Throws for an SDDL string
 * it cannot parse, so callers fail closed. */
export function broadAllowEntries(sddl: string): string[] {
  const { flags, entries } = daclEntries(sddl);
  if (flags.includes('NO_ACCESS_CONTROL')) return ['NO_ACCESS_CONTROL'];
  const broad: string[] = [];
  for (const entry of entries) {
    // type;flags;rights;object;inherited object;trustee[;condition]
    const fields = entry.split(';');
    if (fields.length < 6) throw malformed();
    if (ALLOW_TYPES.has(fields[0]) && BROAD_PRINCIPALS.has(fields[5]))
      broad.push(entry);
  }
  return broad;
}

export type WindowsAclReader = (directory: string) => Promise<string>;

/** Read a directory's security descriptor as SDDL with the system icacls,
 * resolved from %SystemRoot% rather than PATH. */
export const readWindowsDirectorySddl: WindowsAclReader = async (directory) => {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot))
    throw new Error('Windows system directory is unavailable');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-acl-'));
  try {
    const saved = path.join(scratch, 'acl');
    await promisify(execFile)(
      path.win32.join(systemRoot, 'System32', 'icacls.exe'),
      [directory, '/save', saved, '/q'],
      { timeout: 10_000, windowsHide: true },
    );
    // icacls /save writes UTF-16LE: the object name, then its SDDL.
    const lines = (await fs.readFile(saved))
      .toString('utf16le')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/);
    const sddl = lines.find((line) => /^[OGDS]:/.test(line));
    if (!sddl) throw new Error('Unreadable Windows security descriptor');
    return sddl;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
};

const verified = new Set<string>();

/** Windows ignores POSIX mode bits, so a private delegation directory is
 * checked by its DACL instead: no allow entry for a broad principal. Verified
 * once per directory and process. A no-op on POSIX. */
export async function assertPrivateDirectoryAcl(
  directory: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly readSddl?: WindowsAclReader;
  } = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') return;
  const key = path.win32.resolve(directory).toLowerCase();
  if (verified.has(key)) return;
  const sddl = await (options.readSddl ?? readWindowsDirectorySddl)(directory);
  if (broadAllowEntries(sddl).length)
    throw new Error('Delegation storage directory is not private');
  verified.add(key);
}

/** Attempts for a replacing rename on Windows. The linear backoff totals
 * about 2.25 seconds; half a second was not enough for a scanner or a
 * concurrent reader holding a freshly written record. */
export const WINDOWS_RENAME_ATTEMPTS = 10;

/** Windows antivirus and indexers briefly hold new files open; a replacing
 * rename then fails with EPERM/EBUSY/EACCES. Retry a bounded number of times. */
export async function renameWithRetry(
  from: string,
  to: string,
  attempts = process.platform === 'win32' ? WINDOWS_RENAME_ATTEMPTS : 1,
  rename: (from: string, to: string) => Promise<void> = fs.rename,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
      if (
        attempt >= attempts ||
        (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}
