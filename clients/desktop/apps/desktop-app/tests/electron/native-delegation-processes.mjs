// Test-only helpers that find the native delegation processes (provider CLIs
// and the file broker) owned by an Electron process tree. The platform is
// always passed in, so callers resolve it once through the core platform
// helper and these functions stay plain-node testable.
import { readlinkSync } from 'node:fs';

// Case-insensitive Windows image name without its directory or `.exe`.
export function windowsImageName(command) {
  return command
    .split(/[\\/]/)
    .at(-1)
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

export function isNativeDelegationProcess(command, platform) {
  return platform === 'win32'
    ? ['claude', 'codex', 'canopy-file-broker'].includes(
        windowsImageName(command),
      )
    : /(?:^|\/)(?:claude|codex|canopy-file-broker)$/.test(command);
}

export function isFileBroker(entry, platform) {
  return platform === 'win32'
    ? windowsImageName(entry.command) === 'canopy-file-broker'
    : entry.command.endsWith('/canopy-file-broker');
}

// Parses `ps -axo pid=,ppid=,comm=` output. On macOS `comm` is the full
// executable path; on Linux it is only the bare, 15-character-truncated name.
export function parsePosixProcessTable(stdout) {
  return stdout
    .split('\n')
    .map((row) => row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((row) => ({
      pid: Number(row[1]),
      parent: Number(row[2]),
      command: row[3],
    }));
}

// Absolute executable path of a live process (Linux `/proc/<pid>/exe`).
export function readLinuxExecutable(pid, readlink = readlinkSync) {
  return readlink(`/proc/${pid}/exe`);
}

function ownedProcessIds(rows, rootPid) {
  const owned = new Set([rootPid]);
  for (let size = 0; size !== owned.size; ) {
    size = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
  }
  return owned;
}

function ownedRows(rows, rootPid) {
  const owned = ownedProcessIds(rows, rootPid);
  return rows.filter((row) => owned.has(row.pid));
}

// A process that exited between the snapshot and the read has no executable
// left to inspect. Any other failure (such as EACCES or EPERM) is a live owned
// process we could not identify, which must not look like "no such process".
function hasExited(error) {
  return error?.code === 'ENOENT' || error?.code === 'ESRCH';
}

// Linux `ps comm` is a bare, truncated name, so the ownership tree decides
// which processes to inspect and only those are resolved to their absolute
// executable. Unrelated processes are never read.
function linuxOwnedRows(rows, rootPid, readExecutable) {
  const resolved = [];
  for (const row of ownedRows(rows, rootPid)) {
    try {
      resolved.push({ ...row, command: readExecutable(row.pid) });
    } catch (error) {
      if (!hasExited(error)) throw error;
    }
  }
  return resolved;
}

// Selects the native delegation processes among `rootPid` and its descendants.
// macOS `ps` and the Windows process list already carry the full image path.
export function selectNativeDescendants({
  rows,
  rootPid,
  platform,
  readExecutable = readLinuxExecutable,
}) {
  const candidates =
    platform === 'linux'
      ? linuxOwnedRows(rows, rootPid, readExecutable)
      : ownedRows(rows, rootPid);
  return candidates.filter((row) =>
    isNativeDelegationProcess(row.command, platform),
  );
}
