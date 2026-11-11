import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { WebSocketServer } from 'ws';
import { tsImport } from 'tsx/esm/api';
import { loadBrand } from '../../../../../scripts/brand/load-brand.mjs';
import {
  registerScenario,
  clearScenario,
} from '../mock-server/control-plane.mjs';
import { handleAuthUsageRequest } from '../mock-server/routes/authUsage.mjs';
import {
  buildResponsesEvents,
  handleLlmRequest,
  resolveResponsesReply,
} from '../mock-server/routes/llm.mjs';

const pathsModule = await tsImport(
  '../../../../../packages/execution-engine/src/pipelines/config-paths.ts',
  import.meta.url,
);
const { getBundledCodexBinaryPath } = pathsModule.default ?? pathsModule;

// The mock has no remote catalog; use a bundled inline-tool profile for Sol.
// Revisit when the bundled Sol profile supports inline exec_command itself.
export function seedDelegationConfinementModel(userDataDir) {
  const home = path.join(userDataDir, 'provider-state', 'codex');
  mkdirSync(home, { recursive: true });
  const previous = process.env.CANOPY_ENV;
  let binary;
  process.env.CANOPY_ENV = 'development';
  try {
    binary = getBundledCodexBinaryPath();
  } finally {
    if (previous === undefined) delete process.env.CANOPY_ENV;
    else process.env.CANOPY_ENV = previous;
  }
  const catalog = JSON.parse(
    execFileSync(binary, ['debug', 'models', '--bundled'], {
      // Test-process catalog dump, not a product spawn; no user-tool PATH needed.
      env: { ...process.env, CODEX_HOME: home },
      encoding: 'utf8',
      timeout: 15_000,
    }),
  );
  const slug = 'gpt-6.1-sol';
  const bundled = catalog.models.find((model) => model.slug === slug);
  if (bundled && bundled.tool_mode !== 'code_mode_only') return;
  const template = catalog.models.find((model) => model.slug === 'gpt-5.5');
  if (!template || template.tool_mode === 'code_mode_only')
    throw new Error(
      'No bundled inline-tool Codex profile for confinement fixture',
    );
  catalog.models = catalog.models.filter((model) => model.slug !== slug);
  catalog.models.push({ ...template, slug, display_name: 'GPT 6.1 Sol' });
  const file = path.join(home, 'confinement-models.json');
  writeFileSync(file, JSON.stringify(catalog));
  appendFileSync(
    path.join(home, 'config.toml'),
    `model_catalog_json = ${JSON.stringify(file)}\n`,
  );
}

// Script inference only: provider processes, tools and native sandboxes are real.
// A local server lets the first child request create its late sibling before
// returning a command; the shared server cannot run a test-owned filesystem hook.
export async function createConfinementInference({
  cases,
  onFirstChildRequest,
}) {
  const marker = 'Canopy-CNATIVECONFINEMENT';
  const namespace = loadBrand(process.env.CANOPY_BRAND || 'canopy').tools
    .namespace;
  const observations = new Map();
  const errors = [];
  registerScenario(marker, {
    llm: {
      steps: [
        {
          toolCalls: cases.map((entry) => ({
            id: `toolu_confinement_${entry.profile}`,
            name: `mcp__${namespace}__DelegateTask`,
            input: {
              model: 'gpt-6.1-sol',
              description: entry.profile,
              prompt: `[${entry.marker}] Inspect the checkout and report the result.`,
              run_in_background: false,
              ...(entry.profile === 'delegated_write'
                ? { permissions: { writePaths: ['.'] } }
                : {}),
            },
          })),
          stopReason: 'tool_use',
        },
        { text: 'Finished both confined inspections', stopReason: 'end_turn' },
      ],
    },
  });

  function childEvents(body) {
    const items = body.input ?? [];
    const userText = JSON.stringify(
      items.filter((item) => item.role === 'user'),
    );
    const entry = cases.find((candidate) =>
      userText.includes(candidate.marker),
    );
    let step;
    if (entry) {
      let observation = observations.get(entry.profile);
      if (!observation) {
        observation = { firstRequestAt: Date.now(), results: [] };
        observations.set(entry.profile, observation);
        onFirstChildRequest(entry);
        observation.lateCreatedAt = Date.now();
        step = {
          toolCalls: [
            {
              namespace: 'functions',
              name: 'exec_command',
              input: {
                cmd: entry.command,
                login: false,
                max_output_tokens: 3000,
              },
            },
          ],
          stopReason: 'tool_use',
        };
      } else {
        observation.results.push(
          ...items
            .filter((item) => item.type === 'function_call_output')
            .map((item) => item.output),
        );
        step = { text: entry.finding, stopReason: 'end_turn' };
      }
    } else {
      step = resolveResponsesReply(body).step;
    }
    return buildResponsesEvents(
      step,
      { inputTokens: 42, outputTokens: 12 },
      body.model,
    );
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (await handleAuthUsageRequest(request, response, url)) return;
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (url.pathname.endsWith('/responses')) {
        const events = childEvents(JSON.parse(bytes.toString()));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of events)
          response.write(
            `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
          );
        response.end();
      } else {
        const replay = Readable.from([bytes]);
        Object.assign(replay, {
          headers: request.headers,
          method: request.method,
          url: request.url,
        });
        if (!(await handleLlmRequest(replay, response, url)))
          response.writeHead(404).end();
      }
    })().catch((error) => {
      errors.push(String(error));
      response.destroy();
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on('error', () => undefined);
      ws.on('message', (data) => {
        try {
          const body = JSON.parse(data.toString());
          if (body.type !== 'response.create') return;
          for (const event of childEvents(body))
            ws.send(JSON.stringify(event.data));
        } catch (error) {
          errors.push(String(error));
          ws.close();
        }
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    marker,
    observations,
    errors,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      clearScenario(marker);
    },
  };
}
