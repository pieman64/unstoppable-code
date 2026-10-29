// Live Ollama delegate compatibility through a loopback fake HTTP endpoint.
// The bundled Claude CLI and SDK still perform the real provider stream; only
// the remote Ollama server is replaced. This is distinct from persisted model
// handoff coverage in continue-on-provider.spec.mjs.
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

const MARKER = 'Canopy-COLLAMASTREAM';
const RESPONSE = 'Ollama loopback-only HTTP stream completed';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'ollama-live-stream';

async function startFakeOllama() {
  const requests = [];
  const sockets = new Set();
  const upstreamRequests = new Set();
  const upstreamResponses = new Set();
  const server = createServer((incoming, outgoing) => {
    const pathname = new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname;
    const requestEntry = { method: incoming.method, pathname };
    requests.push(requestEntry);
    if (pathname === '/api/version') {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ version: '0.14.1' }));
      return;
    }
    if (pathname === '/api/tags') {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(
        JSON.stringify({
          models: [{ name: 'qwen3-coder', model: 'qwen3-coder' }],
        }),
      );
      return;
    }
    if (pathname === '/api/show') {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
      return;
    }
    if (pathname === '/v1/messages') {
      let body = '';
      incoming.on('data', (chunk) => {
        if (body.length < 64 * 1024) body += chunk.toString('utf8');
      });
      incoming.on('end', () => {
        try {
          requestEntry.model = JSON.parse(body).model;
        } catch {
          requestEntry.model = null;
        }
        outgoing.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const event = (name, data) => {
          outgoing.write(`event: ${name}\n`);
          outgoing.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        event('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_ollama_loopback_only',
            type: 'message',
            role: 'assistant',
            model: 'qwen3-coder',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1 },
          },
        });
        event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: RESPONSE },
        });
        event('content_block_stop', {
          type: 'content_block_stop',
          index: 0,
        });
        event('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 8 },
        });
        event('message_stop', { type: 'message_stop' });
        outgoing.end();
      });
      return;
    }
    if (pathname !== '/v1/messages/count_tokens') {
      outgoing.writeHead(404);
      outgoing.end();
      return;
    }
    const target = new URL(incoming.url, DEFAULT_MOCK_BASE_URL);
    const upstream = httpRequest(
      target,
      {
        method: incoming.method,
        headers: { ...incoming.headers, host: target.host },
      },
      (response) => {
        upstreamResponses.add(response);
        response.once('close', () => upstreamResponses.delete(response));
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstreamRequests.add(upstream);
    upstream.once('close', () => upstreamRequests.delete(upstream));
    upstream.on('error', (error) => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end(String(error));
    });
    incoming.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fake Ollama did not bind a loopback port');
  }
  return {
    port: address.port,
    requests,
    close: () => {
      for (const upstream of upstreamRequests) upstream.destroy();
      for (const response of upstreamResponses) response.destroy();
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test('Ollama chat streams a response through its Claude SDK delegate over fake HTTP', async () => {
  test.setTimeout(120_000);
  const fake = await startFakeOllama();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ollama-live-'),
  );
  let electronApp;
  try {
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: {
        ollamaConnectionMode: 'manual',
        ollamaServerPort: fake.port,
      },
    });
    writeJson(path.join(userDataDir, 'ollama-model-cache.json'), {
      version: 1,
      byPort: {
        [fake.port]: {
          refreshedAt: new Date().toISOString(),
          models: [
            {
              id: 'ollama-qwen3-coder',
              rawModelId: 'qwen3-coder',
              label: 'qwen3-coder',
              show: { capabilities: ['completion', 'tools'] },
            },
          ],
        },
      },
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'ollama',
      tabs: [
        {
          id: CHAT_ID,
          title: 'Ollama live stream',
          providerType: 'ollama',
          executionHarness: 'claude',
          executionHarnessExplicitlyChosen: true,
          model: 'ollama-qwen3-coder',
        },
      ],
    });
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    ));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await expect(panel).toBeVisible();
    const composer = panel.locator('[data-chat-composer-root]');
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      'qwen3-coder',
    );
    const selected = await window.evaluate(
      async (target) => {
        const state = await window.api.chat.getState({
          projectId: target.projectId,
          worktreeId: target.worktreeId,
        });
        const tab = state.tabsFile.tabs.find(
          (entry) => entry.id === target.chatId,
        );
        return {
          providerType: tab?.providerType,
          executionHarness: tab?.executionHarness,
          model: tab?.model,
        };
      },
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
      },
    );
    console.log(
      `OLLAMA_SELECTED ${JSON.stringify({ selected, requests: fake.requests })}`,
    );
    expect(selected).toEqual({
      providerType: 'ollama',
      executionHarness: 'claude',
      model: 'ollama-qwen3-coder',
    });
    await composer.getByRole('textbox').fill(`[${MARKER}] Report status.`);
    await composer.getByRole('button', { name: 'Send message' }).click();
    await expect(
      panel.getByText(RESPONSE, { exact: false }).first(),
    ).toBeVisible({ timeout: 60_000 });
    expect(
      fake.requests.some((entry) => entry.pathname === '/api/version'),
    ).toBe(true);
    expect(fake.requests).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        pathname: '/v1/messages',
        model: 'qwen3-coder',
      }),
    );
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      else rmSync(userDataDir, { recursive: true, force: true });
    } finally {
      await fake.close();
    }
  }
});
