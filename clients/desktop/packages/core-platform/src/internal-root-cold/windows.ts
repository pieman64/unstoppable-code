import { windowsColdObservation } from '../supervision/windows-process';
import { hostPlatformOperatingSystem } from '../platform-services';
import type { NativeColdProcess } from './types';
export { WindowsColdInspectionError } from '../supervision/windows-process';

function decodePath(encoded: string): string {
  const path = (encoded.match(/.{4}/g) ?? [])
    .map((code) => String.fromCharCode(parseInt(code, 16)))
    .join('');
  if (path.includes('\0')) throw new Error('Invalid Windows path');
  return path;
}

function imageName(image: string): string | undefined {
  return image.split(/[\\/]/).pop()?.toLowerCase();
}

/** A successful exit alone is insufficient: every row and the final count are framed. */
export function parseWindowsColdObservation(
  stdout: string,
): readonly NativeColdProcess[] {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n');
  if (lines.shift() !== 'canopy-cold-v1' || lines.pop() !== '')
    throw new Error('Incomplete Windows cold receipt');
  const ownerIsUser = lines[0] === 'owner-is-user';
  if (ownerIsUser) lines.shift();
  const trailer = lines.pop();
  const total = /^complete (0|[1-9]\d*)$/.exec(trailer ?? '');
  if (!total) throw new Error('Incomplete Windows cold observation');
  const rows: NativeColdProcess[] = [];
  let current:
    | {
        pid: number;
        scope: 'same-user' | 'foreign' | 'post-t';
        parentPid: number | null;
        startIdentity: string | null;
        executable: string | null;
        paths: string[];
        windowsDeletedMappings?: string[];
        windowsUnlinkedFiles?: { volumeSerial: string; fileId: string }[];
      }
    | undefined;
  let cwd = false;
  for (const line of lines) {
    const deletedMapping = /^m ntfs ((?:[0-9a-f]{4}){1,32768})$/.exec(line);
    if (deletedMapping) {
      const path = decodePath(deletedMapping[1] ?? '');
      const component = path.split('\\').pop();
      if (
        !current ||
        current.scope === 'foreign' ||
        !/^\\Device\\[^\\/:]+\\\$Extend\\\$Deleted\\[^\\/:]+$/.test(path) ||
        component === '.' ||
        component === '..'
      )
        throw new Error('Invalid Windows NTFS deleted mapping evidence');
      (current.windowsDeletedMappings ??= []).push(path);
      continue;
    }
    const unlinked = /^d ([0-9a-f]{16}) ([0-9a-f]{32})$/.exec(line);
    if (unlinked) {
      const volumeSerial = unlinked[1];
      const fileId = unlinked[2];
      if (!current || current.scope === 'foreign' || !volumeSerial || !fileId)
        throw new Error('Invalid Windows unlinked object evidence');
      (current.windowsUnlinkedFiles ??= []).push({ volumeSerial, fileId });
      continue;
    }
    const exited = /^exited ([1-9]\d*) ((?:[0-9a-f]{4}){1,32768})$/.exec(line);
    if (exited) {
      const pid = Number(exited[1]);
      const executable = decodePath(exited[2] ?? '');
      const index = rows.findIndex((row) => row.pid === pid);
      const previous = current ?? rows[index];
      if (
        !ownerIsUser ||
        pid < 2 ||
        pid > 2147483647 ||
        (current && current.pid !== pid) ||
        previous?.scope === 'exited' ||
        previous?.scope === 'post-t' ||
        (previous?.executable &&
          imageName(previous.executable) !== imageName(executable))
      )
        throw new Error('Invalid Windows exit evidence');
      const row: NativeColdProcess = {
        pid,
        scope: 'exited',
        executable,
        paths: [],
        parentPid: previous?.parentPid ?? null,
        startIdentity: previous?.startIdentity ?? null,
      };
      if (index < 0) rows.push(row);
      else rows[index] = row;
      current = undefined;
      continue;
    }
    const arrival = /^a ([1-9]\d*)$/.exec(line);
    if (arrival) {
      const pid = Number(arrival[1]);
      if (
        !ownerIsUser ||
        current ||
        pid < 2 ||
        pid > 2147483647 ||
        rows.some((row) => row.pid === pid)
      )
        throw new Error('Invalid Windows post-T evidence');
      current = {
        pid,
        scope: 'post-t',
        parentPid: null,
        startIdentity: null,
        executable: null,
        paths: [],
      };
      cwd = false;
      continue;
    }
    const foreign =
      /^x (0|[1-9]\d*) (foreign-token|foreign-owner|owner-rights-denied|kernel-idle)$/.exec(
        line,
      );
    if (foreign) {
      const pid = Number(foreign[1]);
      if (
        !ownerIsUser ||
        current ||
        pid > 2147483647 ||
        rows.some((row) => row.pid === pid)
      )
        throw new Error('Invalid foreign scope receipt');
      current = {
        pid,
        scope: 'foreign',
        parentPid: null,
        startIdentity: null,
        executable: null,
        paths: [],
      };
      cwd = false;
      continue;
    }
    const process = /^p ([1-9]\d*) (0|[1-9]\d*) (\d{20})$/.exec(line);
    if (process) {
      if (current) throw new Error('Unterminated Windows process');
      const pid = Number(process[1]);
      const parentPid = Number(process[2]);
      const ticks = process[3] ?? '';
      if (
        pid < 2 ||
        pid > 2147483647 ||
        parentPid > 2147483647 ||
        BigInt(ticks) <= 9n ||
        BigInt(ticks) > 2650467743999999999n ||
        rows.some((row) => row.pid === pid)
      )
        throw new Error('Invalid Windows process identity');
      current = {
        pid,
        scope: 'same-user',
        parentPid,
        startIdentity: `win32:v1:${pid}:${ticks}`,
        executable: null,
        paths: [],
      };
      cwd = false;
    } else if (line === 'end') {
      if (!current?.executable || (current.scope === 'same-user' && !cwd))
        throw new Error('Incomplete Windows process');
      rows.push(current);
      current = undefined;
    } else {
      const field = /^([ecf]) ((?:[0-9a-f]{4}){1,32768})$/.exec(line);
      if (!current || !field)
        throw new Error('Malformed Windows path evidence');
      const path = decodePath(field[2] ?? '');
      if (
        path.includes('\0') ||
        ((current.scope === 'same-user' ||
          (current.scope === 'post-t' && field[1] !== 'e')) &&
          !/^(?:[A-Za-z]:\\|\\\\)/.test(path))
      )
        throw new Error('Invalid Windows path');
      if (field[1] === 'e') {
        if (current.executable) throw new Error('Duplicate Windows image');
        current.executable = path;
      } else {
        if (current.scope === 'foreign')
          throw new Error('Foreign file-use evidence is unavailable');
        if (field[1] === 'c') {
          if (cwd) throw new Error('Duplicate Windows cwd');
          cwd = true;
        }
        current.paths.push(path);
      }
    }
  }
  if (current || Number(total[1]) !== rows.length)
    throw new Error('Incomplete Windows process set');
  return rows;
}

export async function observeWindowsColdProcesses(
  helperPath: string,
): Promise<readonly NativeColdProcess[]> {
  if (hostPlatformOperatingSystem() !== 'win32')
    throw new Error('Windows observation required');
  const rows = parseWindowsColdObservation(
    await windowsColdObservation(helperPath, 'cold-snapshot', process.pid),
  );
  if (!rows.some((row) => row.pid === process.pid && row.scope === 'same-user'))
    throw new Error('Incomplete Windows process set');
  return rows;
}

/** Target-only qualification, never whole-host admission. */
export async function observeWindowsColdProcess(
  helperPath: string,
  pid: number,
): Promise<NativeColdProcess> {
  if (hostPlatformOperatingSystem() !== 'win32')
    throw new Error('Windows observation required');
  const rows = parseWindowsColdObservation(
    await windowsColdObservation(helperPath, 'cold-process', pid),
  );
  const row = rows[0];
  if (rows.length !== 1 || row?.pid !== pid)
    throw new Error('Incomplete Windows process');
  return row;
}
