import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { handleCloudRequest } from '../mock-server/routes/cloud.mjs';

function canonicalAutomation(name, prompt, targetRequirement) {
  return {
    version: targetRequirement ? 3 : 1,
    ...(targetRequirement ? { targetRequirement } : {}),
    name,
    description: 'Review open work on a recurring schedule.',
    trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt, plugins: [] },
    hasRunCondition: false,
  };
}

export async function startCuratedAutomationsCloud({
  reviewName = 'Daily curated review',
  targetRequirement,
} = {}) {
  const counts = { lists: 0, details: 0, queries: [] };
  const state = { offline: false, changed: false, listGate: null };
  const entries = Array.from({ length: 30 }, (_, index) => {
    const name = index === 0 ? reviewName : `Curated Automation ${index}`;
    const automation = canonicalAutomation(
      name,
      index === 0 ? 'Review open work' : `Review queue ${index}`,
      targetRequirement,
    );
    const serialized = JSON.stringify(automation);
    return {
      key: `curated-automation-${index}`,
      name,
      shortDescription: automation.description,
      icon: '',
      triggerKind: 'cron',
      cronExpression: automation.trigger.expression,
      actionType: automation.action.type,
      pipelineSource: null,
      referencedCuratedPipelineKey: null,
      pluginCount: 0,
      contentHash: createHash('sha256').update(serialized).digest('hex'),
      contentSizeBytes: Buffer.byteLength(serialized),
      categories: ['productivity'],
      popular: index === 0,
      sortOrder: index,
      revision: 1,
      authorName: null,
      authorUrl: null,
      docsUrl: null,
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
      automation,
    };
  });
  // A catalog change republishes the entry: the list and the detail answer
  // with the same new revision and hash, as the real service does.
  const current = (entry) => {
    if (!state.changed) return entry;
    const automation = canonicalAutomation(
      entry.name,
      'Review changed open work',
      targetRequirement,
    );
    const serialized = JSON.stringify(automation);
    return {
      ...entry,
      automation,
      revision: 2,
      contentHash: createHash('sha256').update(serialized).digest('hex'),
      contentSizeBytes: Buffer.byteLength(serialized),
    };
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (status, data) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    if (url.pathname.startsWith('/api/v1/curated-automations')) {
      if (!/^Bearer csk_/.test(request.headers.authorization ?? '')) {
        send(401, { error: 'Invalid API key' });
        return;
      }
      if (state.offline) {
        send(503, { error: 'Catalog temporarily offline' });
        return;
      }
      if (url.pathname === '/api/v1/curated-automations') {
        counts.lists += 1;
        counts.queries.push(Object.fromEntries(url.searchParams));
        if (state.listGate) await state.listGate;
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const items = entries.filter(
          (entry) =>
            (!q ||
              entry.key.toLowerCase().includes(q) ||
              entry.name.toLowerCase().includes(q) ||
              entry.shortDescription.toLowerCase().includes(q)) &&
            (!url.searchParams.get('actionType') ||
              entry.actionType === url.searchParams.get('actionType')) &&
            (!url.searchParams.get('category') ||
              entry.categories.includes(url.searchParams.get('category'))),
        );
        const offset = Number(url.searchParams.get('cursor') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? '25');
        send(200, {
          version: 1,
          data: items
            .slice(offset, offset + limit)
            .map(current)
            .map(({ automation, ...row }) => row),
          nextCursor:
            offset + limit < items.length ? String(offset + limit) : null,
        });
        return;
      }
      counts.details += 1;
      const key = decodeURIComponent(url.pathname.split('/').at(-1));
      const entry = entries.find((candidate) => candidate.key === key);
      if (!entry) {
        send(404, { error: 'Not found' });
        return;
      }
      send(200, current(entry));
      return;
    }
    if (await handleCloudRequest(request, response, url)) return;
    send(404, { error: 'Not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    counts,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
