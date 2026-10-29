import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { handleCloudRequest } from '../mock-server/routes/cloud.mjs';

/** Per-test Cloud transport. Other Cloud routes use the suite's existing implementation. */
export async function startCuratedPipelinesCloud({
  reviewName = 'Curated review workflow',
  triggerType = 'dispatch',
} = {}) {
  const counts = { lists: 0, details: 0, queries: [] };
  // `listGate`, when set to a promise, holds catalog list responses until it
  // settles, so a spec can observe a refresh while it is in flight.
  /** @type {{ offline: boolean, changed: boolean, listGate: Promise<void> | null }} */
  const state = { offline: false, changed: false, listGate: null };
  const rawPipeline = `name: ${reviewName}\non: ${triggerType}\nscope: [directory]\njobs:\n  review:\n    steps:\n      - run: |\n          echo reviewed\n${'          # Large reviewed definition content.\n'.repeat(6000)}`;
  const hash = createHash('sha256').update(rawPipeline).digest('hex');
  const summaries = Array.from({ length: 30 }, (_, index) => ({
    key: `curated-review-${index}`,
    name:
      index === 0
        ? reviewName
        : `Curated workflow ${String(index).padStart(2, '0')}`,
    shortDescription:
      'Review a ready-made workflow, then add an editable local copy.',
    icon: '',
    version: '1.0.0',
    triggerTypes: [triggerType],
    scopes: ['directory'],
    jobCount: 1,
    stepCount: 1,
    contentHash: hash,
    contentSizeBytes: Buffer.byteLength(rawPipeline),
    categories: ['development'],
    popular: index === 0,
    sortOrder: index,
    revision: 1,
    authorName: 'Canopy',
    authorUrl: null,
    docsUrl: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  }));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const content = state.changed ? `${rawPipeline}# changed\n` : rawPipeline;
    const currentSummary = (summary) => ({
      ...summary,
      revision: state.changed ? 2 : 1,
      contentSizeBytes: Buffer.byteLength(content),
      contentHash: createHash('sha256').update(content).digest('hex'),
    });
    const send = (status, data) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    if (url.pathname.includes('/pipelines/curated')) {
      if (!/^Bearer csk_/.test(request.headers.authorization ?? '')) {
        send(401, { error: 'Invalid API key' });
        return;
      }
      if (state.offline) {
        send(503, { error: 'Catalog temporarily offline' });
        return;
      }
      if (url.pathname.endsWith('/curated')) {
        counts.lists += 1;
        counts.queries.push(Object.fromEntries(url.searchParams));
        if (state.listGate) await state.listGate;
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const items = summaries.filter(
          (row) =>
            // `key` is matched alongside name and description because the real
            // curated endpoint searches the slug too — a spec that searches by
            // key would otherwise pass against production and fail here, which
            // is the wrong direction for a fake to diverge.
            (row.key.toLowerCase().includes(q) ||
              row.name.toLowerCase().includes(q) ||
              row.shortDescription.toLowerCase().includes(q)) &&
            (!url.searchParams.get('scope') ||
              row.scopes.includes(url.searchParams.get('scope'))) &&
            (!url.searchParams.get('triggerType') ||
              row.triggerTypes.includes(url.searchParams.get('triggerType'))) &&
            (!url.searchParams.get('category') ||
              row.categories.includes(url.searchParams.get('category'))),
        );
        const offset = Number(url.searchParams.get('cursor') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? '25');
        send(200, {
          version: 1,
          data: items.slice(offset, offset + limit).map(currentSummary),
          nextCursor:
            offset + limit < items.length ? String(offset + limit) : null,
        });
        return;
      }
      counts.details += 1;
      const key = url.pathname.split('/').at(-2);
      const summary = summaries.find((row) => row.key === key);
      if (!summary) {
        send(404, { error: 'Not found' });
        return;
      }
      send(200, {
        ...currentSummary(summary),
        rawPipeline: content,
      });
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
    hash,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
