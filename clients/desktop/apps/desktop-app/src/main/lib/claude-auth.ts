import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentProviderAuthStatus } from '@canopy/desktop-shared/types';
import {
  getBundledClaudeBinaryPath,
  getEnhancedEnv,
} from '../pipelines/config-paths';

const execFileAsync = promisify(execFile);

export interface ClaudeAuthInfo {
  authenticated: boolean;
  email: string | null;
  accountLabel: string | null;
  detail: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === 'string' && field.trim().length > 0
    ? field.trim()
    : null;
}

function readBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean | null {
  const field = value[key];
  return typeof field === 'boolean' ? field : null;
}

function isMissingExecutableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = 'code' in error ? error.code : null;
  return (
    (typeof code === 'string' && code === 'ENOENT') ||
    error.message.includes('ENOENT')
  );
}

function buildClaudeAuthDetail(
  payload: Record<string, unknown>,
): string | null {
  const method = readString(payload, 'authMethod');
  const subscription = readString(payload, 'subscriptionType');
  if (method && subscription) {
    return `${method} (${subscription})`;
  }
  return method ?? subscription;
}

export async function readClaudeAuthInfo(
  timeoutMs = 10_000,
): Promise<ClaudeAuthInfo> {
  const { stdout } = await execFileAsync(
    getBundledClaudeBinaryPath(),
    ['auth', 'status', '--json'],
    {
      timeout: timeoutMs,
      env: getEnhancedEnv(),
      windowsHide: process.platform === 'win32',
    },
  );
  const payload: unknown = JSON.parse(stdout);
  if (!isRecord(payload)) {
    throw new Error('Invalid Claude auth status response.');
  }

  const authenticated = readBoolean(payload, 'loggedIn') === true;
  const email = readString(payload, 'email');
  return {
    authenticated,
    email,
    accountLabel: email ?? readString(payload, 'orgName'),
    detail: buildClaudeAuthDetail(payload),
  };
}

export async function checkClaudeAuthStatus(): Promise<AgentProviderAuthStatus> {
  try {
    const info = await readClaudeAuthInfo();
    return {
      authenticated: info.authenticated,
      accountLabel: info.accountLabel,
      detail: info.detail,
      error: info.authenticated ? null : 'Claude is not authenticated.',
    };
  } catch (error: unknown) {
    return {
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: isMissingExecutableError(error)
        ? 'Claude CLI is not installed.'
        : 'Claude is not authenticated.',
    };
  }
}
