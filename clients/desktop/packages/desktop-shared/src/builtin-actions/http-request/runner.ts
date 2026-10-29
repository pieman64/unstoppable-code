import { readFileSync } from 'node:fs';
import { setOutput, writeOutputFile } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';
import { requestWithRetry } from '../shared/http';
import { parseStringRecord, stringifySingleLine } from '../shared/json';

const DEFAULT_TIMEOUT_SECONDS = 30;
const BODY_OUTPUT_LIMIT = 16 * 1024;

function parseIntegerInput(
  raw: string | undefined,
  defaultValue: number,
  label: string,
): number {
  if (!raw?.trim()) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function readBody(env: NodeJS.ProcessEnv): string | undefined {
  const bodyFile = env.INPUT_BODY_FILE?.trim();
  if (bodyFile) {
    return readFileSync(bodyFile, 'utf8');
  }
  return env.INPUT_BODY;
}

function outputSafeBody(body: string): string {
  return body
    .slice(0, BODY_OUTPUT_LIMIT)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function parseExpectedStatus(raw: string | undefined): Set<number> | null {
  if (!raw?.trim()) {
    return null;
  }

  const statuses = new Set<number>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const rangeSeparator = trimmed.indexOf('-');
    if (rangeSeparator > 0) {
      const start = Number(trimmed.slice(0, rangeSeparator));
      const end = Number(trimmed.slice(rangeSeparator + 1));
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end
      ) {
        throw new Error('expected_status contains an invalid range');
      }
      for (let status = start; status <= end; status++) {
        statuses.add(status);
      }
      continue;
    }
    const status = Number(trimmed);
    if (!Number.isSafeInteger(status)) {
      throw new Error('expected_status contains an invalid status code');
    }
    statuses.add(status);
  }

  return statuses;
}

function isJsonResponse(
  headers: Record<string, string>,
  body: string,
): boolean {
  const contentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
  if (contentType.toLowerCase().includes('json')) {
    return true;
  }
  const firstChar = body.trimStart().charAt(0);
  if (firstChar !== '{' && firstChar !== '[') {
    return false;
  }
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

export async function runHttpRequestAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    const url = env.INPUT_URL?.trim();
    if (!url) {
      throw new Error('http-request requires input "url"');
    }

    const method = env.INPUT_METHOD?.trim().toUpperCase() || 'GET';
    const headers = parseStringRecord(env.INPUT_HEADERS, 'headers');
    const contentType = env.INPUT_CONTENT_TYPE?.trim();
    const body = readBody(env);
    if (contentType && body !== undefined) {
      headers['Content-Type'] = contentType;
    }

    const authHeaderEnv = env.INPUT_AUTH_HEADER_ENV?.trim();
    if (authHeaderEnv) {
      const authHeaderValue = env[authHeaderEnv];
      if (!authHeaderValue) {
        throw new Error(`auth_header_env "${authHeaderEnv}" is not set`);
      }
      headers.Authorization = authHeaderValue;
    }

    const timeoutSeconds = parseIntegerInput(
      env.INPUT_TIMEOUT_SECONDS,
      DEFAULT_TIMEOUT_SECONDS,
      'timeout_seconds',
    );
    const retries = parseIntegerInput(env.INPUT_RETRIES, 0, 'retries');
    const expectedStatus = parseExpectedStatus(env.INPUT_EXPECTED_STATUS);
    const { response } = await requestWithRetry({
      url,
      method,
      headers,
      body,
      timeoutSeconds,
      retries,
    });

    if (expectedStatus && !expectedStatus.has(response.status)) {
      throw new Error(
        `Expected HTTP status ${env.INPUT_EXPECTED_STATUS ?? ''}, received ${String(response.status)}`,
      );
    }

    setOutput('status', String(response.status));
    setOutput('ok', String(response.ok));
    setOutput('headers_json', stringifySingleLine(response.headers));
    setOutput('body', outputSafeBody(response.body));
    writeOutputFile('body_file', 'http-response-body.txt', response.body);

    if (isJsonResponse(response.headers, response.body)) {
      writeOutputFile('json_file', 'http-response.json', response.body);
    }
  });
}
