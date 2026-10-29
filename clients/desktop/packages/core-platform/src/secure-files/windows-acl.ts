import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { observeWindowsClosure } from '../supervision/windows-closure';
import {
  checkShape,
  fail,
  PRIVATE,
  sameNode,
  type PermissionRequest,
  type PermissionResult,
} from './shared';

/** Returns the JSON receipt printed by `ACL_SCRIPT` for one path. */
export type WindowsAclReader = (target: string) => Promise<string>;

const PATH_VARIABLE = 'CANOPY_SECURE_FILE_PATH';
const MODULES = 'WindowsPowerShell/v1.0/Modules';

// Fixed script: the path is data (environment plus -LiteralPath), never code.
// .NET parses the descriptor; numeric ACE types avoid locale-dependent names.
const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$p = $env:${PATH_VARIABLE}`,
  '$item = Get-Item -LiteralPath $p -Force',
  "$sd = New-Object System.Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $p).GetSecurityDescriptorSddlForm('Owner, Access'))",
  '$aces = @(if ($null -ne $sd.DiscretionaryAcl) { foreach ($ace in $sd.DiscretionaryAcl) { [pscustomobject]@{ type = [int]$ace.AceType; sid = $(if ($ace -is [System.Security.AccessControl.KnownAce]) { $ace.SecurityIdentifier.Value } else { $null }) } } })',
  '[pscustomobject]@{ user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; owner = $(if ($null -ne $sd.Owner) { $sd.Owner.Value } else { $null }); reparse = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint); directory = [bool]$item.PSIsContainer; dacl = $null -ne $sd.DiscretionaryAcl; aces = $aces } | ConvertTo-Json -Compress -Depth 4',
].join('\n');

// Inherited PowerShell 7 module paths break 5.1's Get-Acl autoload. Pinning the
// admin-owned System32 module dir also keeps resolution off user-writable paths.
export function windowsAclEnvironment(
  env: NodeJS.ProcessEnv,
  systemRoot: string,
  target: string,
): NodeJS.ProcessEnv {
  const inherited = Object.entries(env).filter(
    ([key]) => !/^psmodulepath$/i.test(key),
  );
  return {
    ...Object.fromEntries(inherited),
    PSModulePath: path.win32.join(systemRoot, 'System32', MODULES),
    [PATH_VARIABLE]: target,
  };
}

export const readWindowsAcl: WindowsAclReader = async (target) => {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '';
  if (!/^[A-Za-z]:\\/.test(root)) throw new Error('SystemRoot is not absolute');
  const closure = observeWindowsClosure('acl');
  try {
    const execution = promisify(execFile)(
      path.win32.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        ...['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'],
        Buffer.from(ACL_SCRIPT, 'utf16le').toString('base64'),
      ],
      {
        env: windowsAclEnvironment(process.env, root, target),
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: 15_000,
        windowsHide: true,
      },
    );
    execution.child.once('close', (code, signal) => {
      if (code !== 0 || signal !== null) closure?.unsafe();
      closure?.close();
    });
    const { stdout } = await execution;
    return stdout;
  } catch (error) {
    closure?.unsafe();
    throw error;
  }
};

// LocalSystem and BUILTIN\Administrators can take ownership of any file, so
// their grants do not widen access. No other trustee is accepted.
const PRIVILEGED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544']);
const [ACCESS_ALLOWED, ACCESS_DENIED] = [0, 1];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isSid = (value: unknown): value is string =>
  typeof value === 'string' && /^S-1(-\d+)+$/.test(value);

/** Anything not provably private fails closed. */
export function evaluateWindowsAcl(
  text: string,
  kind: PermissionRequest['kind'],
): PermissionResult {
  let receipt: unknown;
  try {
    receipt = JSON.parse(text);
  } catch {
    receipt = undefined;
  }
  if (!isRecord(receipt) || !Array.isArray(receipt.aces)) {
    return fail('unverifiable', 'Windows ACL receipt is malformed');
  }
  const { user, owner, reparse, directory, dacl } = receipt;
  if (!isSid(user) || !isSid(owner)) {
    return fail('unverifiable', 'Windows owner or user identity is missing');
  }
  if (reparse !== false) return fail('insecure', 'path may be a reparse point');
  if (directory !== (kind === 'directory')) {
    return fail('insecure', `path is not a ${kind}`);
  }
  if (owner !== user) return fail('insecure', 'owned by another account');
  if (dacl !== true) return fail('insecure', 'null DACL grants everyone');
  for (const ace of receipt.aces) {
    if (!isRecord(ace) || !isSid(ace.sid)) {
      return fail('unverifiable', 'Windows ACL entry is malformed');
    }
    if (ace.type === ACCESS_DENIED) continue;
    if (ace.type !== ACCESS_ALLOWED) {
      return fail('unverifiable', `unsupported ACE type ${String(ace.type)}`);
    }
    if (ace.sid !== user && !PRIVILEGED_SIDS.has(ace.sid)) {
      return fail('insecure', `ACL grants access to ${ace.sid}`);
    }
  }
  return PRIVATE;
}

/** Read-only: mode bits prove nothing here and insecure ACLs are never repaired. */
export async function windowsPermissions(
  request: PermissionRequest,
  read: WindowsAclReader,
): Promise<PermissionResult> {
  const stats = await lstat(request.path, { bigint: true });
  let result =
    checkShape(stats, request.kind) ??
    evaluateWindowsAcl(await read(request.path), request.kind);
  if (result.state === 'private') {
    const after = await lstat(request.path, { bigint: true });
    result = !sameNode(stats, after)
      ? fail('unverifiable', 'path changed during Windows ACL reading')
      : (checkShape(after, request.kind) ?? result);
  }
  return result.state === 'private' || request.action === 'verify'
    ? result
    : { ...result, reason: `${result.reason}; Windows ACLs are not repaired` };
}
