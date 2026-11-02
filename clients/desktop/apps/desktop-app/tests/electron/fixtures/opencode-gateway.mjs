import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { withPortalDbClient } from '../portal/db.mjs';

export const managedModels = [
  {
    id: 'opencode-e2e-messages',
    gatewayId: 'fixture/opencode-messages',
    label: 'OpenCode Messages fixture',
    harness: 'claude',
  },
  {
    id: 'opencode-e2e-responses',
    gatewayId: 'fixture/opencode-responses',
    label: 'OpenCode Responses fixture',
    harness: 'codex',
  },
];

export async function seedManagedGatewayModels(userId) {
  await withPortalDbClient(async (client) => {
    await client.query(`INSERT INTO ai_gateway_model_families (key, label, minimum_client_catalog_version, updated_at)
      VALUES ('opencode-e2e', 'OpenCode fixture models', 8, now()) ON CONFLICT (key) DO NOTHING`);
    for (const model of managedModels)
      await client.query(
        `INSERT INTO ai_gateway_models
      (client_model_id, gateway_id, label, family, recommended_harness, context_window, minimum_client_catalog_version, updated_at)
      VALUES ($1, $2, $3, 'opencode-e2e', $4::"AiGatewayHarness", 64000, 8, now())
      ON CONFLICT (client_model_id) DO UPDATE SET active = true, updated_at = now()`,
        [model.id, model.gatewayId, model.label, model.harness],
      );
    await client.query(
      `INSERT INTO ai_credit_ledger_entries
      (external_id, user_id, amount_credits, balance_after_credits, transaction_type, reason)
      VALUES ($1, $2, 10000, 10000, 'GRANT', 'opencode_e2e_seed')`,
      [randomUUID(), userId],
    );
  });
}

export async function startManagedGatewayFixture() {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1048576) throw new Error('Fixture request too large');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.stream !== true) throw new Error('Streaming request required');
      if (!managedModels.some((model) => model.gatewayId === body.model))
        throw new Error('Unexpected model');
      requests.push({ model: body.model, url: request.url });
      const messages = request.url?.endsWith('/messages');
      const text = `Managed gateway reply ${requests.length}.`;
      const payload = messages
        ? {
            id: `msg_${requests.length}`,
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }
        : {
            id: `resp_${requests.length}`,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            status: 'completed',
            model: body.model,
            output: [
              {
                id: `item_${requests.length}`,
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text, annotations: [] }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'Invalid fixture request' } }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture address');
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
