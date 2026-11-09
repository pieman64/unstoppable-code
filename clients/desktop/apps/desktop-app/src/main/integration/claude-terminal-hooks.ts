import { DESKTOP_INTEGRATION_TOKEN_ENV_VAR } from '@canopy/desktop-shared/lib/desktop-integration-transport';
import { brandEnvName } from '@canopy/execution-engine/brand/env';

const ELECTRON_NODE_PATH_ENV = brandEnvName('ELECTRON_NODE_PATH');
const APPROVAL_TRANSPORT_TIMEOUT_MS = 590_000;

export function buildClaudeTerminalHookCallbackScript(input: {
  hookUrl: string;
}): string {
  return `const http = require('node:http');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function postJson(url, body, token) {
  return new Promise((resolve) => {
    let settled = false;
    let req;
    let transportTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (transportTimer !== undefined) clearTimeout(transportTimer);
      resolve(value);
    };
    const deny = (reason) => finish(
      body.hookEventName === 'PreToolUse'
        ? {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: reason,
            },
          }
        : undefined
    );
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    req = http.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': 'Bearer ' + token,
      },
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          deny('Approval service rejected the request.');
          return;
        }
        try {
          if (!responseBody) {
            deny('Approval service returned an empty response.');
            return;
          }
          finish(JSON.parse(responseBody));
        } catch {
          deny('Approval service returned an invalid response.');
        }
      });
    });
    req.on('error', () => deny('Approval service request failed.'));
    transportTimer = setTimeout(() => {
      deny('Approval service request timed out.');
      req.destroy();
    }, ${APPROVAL_TRANSPORT_TIMEOUT_MS});
    req.end(payload);
  });
}

(async () => {
  const hookEventName = process.argv[2];
  const token = process.env[${JSON.stringify(DESKTOP_INTEGRATION_TOKEN_ENV_VAR)}] || '';
  let hookPayload = {};
  try {
    const raw = await readStdin();
    hookPayload = raw ? JSON.parse(raw) : {};
  } catch {
    hookPayload = {};
  }
  const result = await postJson(${JSON.stringify(input.hookUrl)}, { hookEventName, hookPayload }, token);
  if (result !== undefined) {
    process.stdout.write(JSON.stringify(result));
  }
})().catch(() => {
  if (process.argv[2] !== 'PreToolUse') {
    return;
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Approval hook failed.',
    },
  }));
});
`;
}

export function buildPosixElectronNodeStub(jsFileName: string): string {
  return `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "$${ELECTRON_NODE_PATH_ENV}" "$(dirname "$0")/${jsFileName}" "$@"
`;
}

export function buildWindowsElectronNodeStub(jsFileName: string): string {
  return `@echo off
set ELECTRON_RUN_AS_NODE=1
"%${ELECTRON_NODE_PATH_ENV}%" "%~dp0${jsFileName}" %*
`;
}
