import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { getMockApiKey, getMockLlmOrigin } from '../lib/e2e-mock-control-plane';
import { getEnhancedEnv } from '../pipelines/config-paths';

/**
 * Claude stores OAuth credentials in macOS Keychain and, on current Windows
 * releases, `.claude/.credentials.json` under the user/config directory.
 * Legacy Windows releases used Credential Manager. Beyond the access token the
 * credential carries two plan signals:
 *
 * - `subscriptionType`: coarse tier (`pro` / `max` / `team`) — notably it
 *   reports both Max 5x and Max 20x as bare `max`.
 * - `rateLimitTier`: the only local signal that distinguishes Max 5x from
 *   Max 20x (observed as e.g. `default_claude_max_20x`). It is a rate-limit
 *   descriptor, not a contractual billing API, so callers should treat its
 *   exact format defensively.
 */
export interface ClaudeOauthCredentials {
  accessToken: string;
  subscriptionType?: string;
  rateLimitTier?: string;
}

export type ClaudeOauthCredentialsReadFailureReason =
  | 'unsupported_platform'
  | 'username_unavailable'
  | 'credential_not_found'
  | 'credential_read_failed'
  | 'credential_parse_failed';

export type ClaudeOauthCredentialsReadFailureSource =
  | 'credentials_file'
  | 'credential_store';

export type ClaudeOauthCredentialsReadResult =
  | {
      status: 'success';
      credentials: ClaudeOauthCredentials;
    }
  | {
      status: 'failure';
      reason: ClaudeOauthCredentialsReadFailureReason;
      source?: ClaudeOauthCredentialsReadFailureSource;
    };

const CLAUDE_CODE_CREDENTIALS_SERVICE = 'Claude Code-credentials';

interface ExecFileOutput {
  stdout: string;
  stderr: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function safeJsonParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function runExecFile(
  file: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  },
): Promise<ExecFileOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        ...options,
        encoding: 'utf8',
        windowsHide: process.platform === 'win32',
      },
      (error: Error | null, stdout: string, stderr: string): void => {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          stdout,
          stderr,
        });
      },
    );
  });
}

function parseClaudeOauthCredentialsJson(
  raw: string,
): ClaudeOauthCredentials | null {
  const parsed = safeJsonParse(raw.trim());
  if (!parsed) {
    return null;
  }

  const oauthValue = parsed['claudeAiOauth'];
  const oauth = isRecord(oauthValue) ? oauthValue : null;
  const accessToken = oauth ? readStringField(oauth, 'accessToken') : undefined;
  if (!oauth || !accessToken) {
    return null;
  }

  return {
    accessToken,
    subscriptionType: readStringField(oauth, 'subscriptionType'),
    rateLimitTier: readStringField(oauth, 'rateLimitTier'),
  };
}

function currentOsUsername(): string | null {
  const environmentUsername =
    process.platform === 'win32' ? process.env.USERNAME : process.env.USER;
  if (environmentUsername?.trim()) {
    return environmentUsername.trim();
  }

  try {
    const username = userInfo().username.trim();
    return username.length > 0 ? username : null;
  } catch {
    return null;
  }
}

/**
 * keytar stores generic Windows credentials under `service/account`, unlike
 * macOS Keychain where service and account remain separate lookup fields.
 */
export function buildWindowsClaudeCredentialTargetName(
  username: string,
): string {
  return `${CLAUDE_CODE_CREDENTIALS_SERVICE}/${username}`;
}

export function getClaudeCredentialsFilePath(): string {
  const configuredDirectory = process.env.CLAUDE_CONFIG_DIR?.trim();
  const credentialsDirectory =
    configuredDirectory || join(homedir(), '.claude');
  return join(credentialsDirectory, '.credentials.json');
}

function isFileNotFoundError(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT';
}

function withOauthTokenFallback(
  result: ClaudeOauthCredentialsReadResult,
  oauthToken: string | undefined,
): ClaudeOauthCredentialsReadResult {
  if (result.status === 'success' || !oauthToken) {
    return result;
  }
  return {
    status: 'success',
    credentials: { accessToken: oauthToken },
  };
}

function decodeWindowsCredentialBlob(base64: string): string[] {
  const blob = Buffer.from(base64.trim(), 'base64');
  if (blob.length === 0) {
    return [];
  }

  const stripTrailingNuls = (value: string): string =>
    value.replace(/\0+$/g, '');
  return [
    stripTrailingNuls(blob.toString('utf8')),
    stripTrailingNuls(blob.toString('utf16le')),
  ];
}

function buildWindowsCredentialReadCommand(targetName: string): string {
  const targetNameBase64 = Buffer.from(targetName, 'utf8').toString('base64');
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CanopyCredentialReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
}
'@
$targetName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${targetNameBase64}'))
$credentialPtr = [IntPtr]::Zero
if (-not [CanopyCredentialReader]::CredRead($targetName, 1, 0, [ref]$credentialPtr)) {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($errorCode -eq 1168) {
    exit 0
  }
  throw "CredRead failed with Windows error $errorCode"
}
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($credentialPtr, [type][CanopyCredentialReader+CREDENTIAL])
  if ($credential.CredentialBlobSize -eq 0) {
    exit 0
  }
  $bytes = New-Object byte[] $credential.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $credential.CredentialBlobSize)
  [Convert]::ToBase64String($bytes)
} finally {
  [CanopyCredentialReader]::CredFree($credentialPtr)
}
`;
}

async function readWindowsCredentialManagerClaudeOauthCredentials(): Promise<ClaudeOauthCredentialsReadResult> {
  const username = currentOsUsername();
  if (!username) {
    return {
      status: 'failure',
      reason: 'username_unavailable',
      source: 'credential_store',
    };
  }

  const command = buildWindowsCredentialReadCommand(
    buildWindowsClaudeCredentialTargetName(username),
  );
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');

  try {
    const { stdout } = await runExecFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedCommand,
      ],
      {
        timeout: 10_000,
        env: getEnhancedEnv({ environment: false }),
      },
    );

    const encodedCredential = stdout.trim();
    if (!encodedCredential) {
      return {
        status: 'failure',
        reason: 'credential_not_found',
        source: 'credential_store',
      };
    }

    for (const candidate of decodeWindowsCredentialBlob(encodedCredential)) {
      const credentials = parseClaudeOauthCredentialsJson(candidate);
      if (credentials) {
        return { status: 'success', credentials };
      }
    }
    return {
      status: 'failure',
      reason: 'credential_parse_failed',
      source: 'credential_store',
    };
  } catch {
    return {
      status: 'failure',
      reason: 'credential_read_failed',
      source: 'credential_store',
    };
  }
}

async function readWindowsClaudeOauthCredentials(): Promise<ClaudeOauthCredentialsReadResult> {
  try {
    const raw = await readFile(getClaudeCredentialsFilePath(), 'utf8');
    const credentials = parseClaudeOauthCredentialsJson(raw);
    return credentials
      ? { status: 'success', credentials }
      : {
          status: 'failure',
          reason: 'credential_parse_failed',
          source: 'credentials_file',
        };
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      return {
        status: 'failure',
        reason: 'credential_read_failed',
        source: 'credentials_file',
      };
    }
  }

  // Claude Code used keytar-backed Windows Credential Manager entries before
  // moving native Windows credentials to `.credentials.json`. Keep a fallback
  // for users who have not yet re-authenticated with a current release.
  return readWindowsCredentialManagerClaudeOauthCredentials();
}

/**
 * Read Claude OAuth credentials while preserving why no credential was
 * returned. Usage UX uses this result to distinguish sign-in, credential-store,
 * and malformed-data failures without exposing credential contents.
 */
export async function readClaudeOauthCredentialsResult(): Promise<ClaudeOauthCredentialsReadResult> {
  // E2E seam (build-gated): skip the OS credential store and return a dummy
  // token so the mock `/api/oauth/usage` fetch has a bearer. Dead-code
  // eliminated from production.
  if (__CANOPY_E2E__) {
    if (getMockLlmOrigin()) {
      return {
        status: 'success',
        credentials: { accessToken: getMockApiKey() },
      };
    }
  }

  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || undefined;

  if (process.platform === 'win32') {
    return withOauthTokenFallback(
      await readWindowsClaudeOauthCredentials(),
      oauthToken,
    );
  }

  if (process.platform !== 'darwin') {
    return withOauthTokenFallback(
      { status: 'failure', reason: 'unsupported_platform' },
      oauthToken,
    );
  }

  const username = currentOsUsername();
  if (!username) {
    return withOauthTokenFallback(
      {
        status: 'failure',
        reason: 'username_unavailable',
        source: 'credential_store',
      },
      oauthToken,
    );
  }

  try {
    const { stdout } = await runExecFile(
      'security',
      [
        'find-generic-password',
        '-a',
        username,
        '-s',
        CLAUDE_CODE_CREDENTIALS_SERVICE,
        '-w',
      ],
      {
        timeout: 10_000,
        env: getEnhancedEnv({ environment: false }),
      },
    );
    const credentials = parseClaudeOauthCredentialsJson(stdout);
    return withOauthTokenFallback(
      credentials
        ? { status: 'success', credentials }
        : {
            status: 'failure',
            reason: 'credential_parse_failed',
            source: 'credential_store',
          },
      oauthToken,
    );
  } catch {
    return withOauthTokenFallback(
      {
        status: 'failure',
        reason: 'credential_read_failed',
        source: 'credential_store',
      },
      oauthToken,
    );
  }
}

/**
 * Read the stored Claude OAuth credentials from the OS credential store, or
 * `null` when unavailable (unsupported platform, not logged in, or a read
 * failure). Cross-platform: macOS Keychain, the current Windows credentials
 * file, and a legacy Windows Credential Manager fallback.
 */
export async function readClaudeOauthCredentials(): Promise<ClaudeOauthCredentials | null> {
  const result = await readClaudeOauthCredentialsResult();
  return result.status === 'success' ? result.credentials : null;
}
