import { parseLocator } from '@canopy/desktop-shared/browser/locator-grammar';
import { evaluateLocator } from '../locators';
import { buildPageModel } from '../page-model';
import { projectInputSnapshot, projectInspect } from '../projections';
import { generatedLocators } from './fixtures/generated-locators';
import {
  appendChild,
  childList,
  cloneRecording,
  elementRecord,
  findTreeNode,
  hasAttribute,
  treeRoot,
} from './fixtures/recording-edit';
import {
  loadRecording,
  recordedDeps,
  recordedSend,
} from './fixtures/recorded-cdp';

/**
 * Every locator the model generates on pages with shadow roots and frames
 * must parse with the shared grammar and resolve, through the same CDP
 * evaluation the host uses (replayed from Chromium), to exactly its node.
 */
describe('generated locators round-trip on recorded Chromium pages (major 3)', () => {
  it.each(['shadow', 'frames', 'oopif'])(
    '%s: every row locator and inspect candidate resolves to its own node',
    async (name) => {
      const recording = loadRecording(name);
      const model = await buildPageModel(recordedDeps(recording));
      const deps = { send: recordedSend(recording) };
      const generated = await generatedLocators(model);
      expect(generated.some((entry) => entry.source === 'row')).toBe(true);
      expect(generated.length).toBeGreaterThan(10);
      const failures: string[] = [];
      for (const entry of generated) {
        const parsed = parseLocator(entry.locator);
        if (parsed.kind === 'invalid') {
          failures.push(`${entry.source} ${entry.locator}: does not parse`);
          continue;
        }
        const matches = await evaluateLocator(model, deps, parsed, undefined, {
          ...(entry.source === 'inspect' ? { purpose: 'inspect' } : {}),
        });
        const exact =
          matches.length === 1 &&
          matches[0]?.frameId === entry.node.identity.frameId &&
          matches[0]?.sessionId === entry.node.identity.sessionId &&
          matches[0]?.backendNodeId === entry.node.identity.backendNodeId;
        if (!exact) {
          failures.push(
            `${entry.source} ${entry.locator} (${entry.node.tagName}#${entry.node.attributes.id ?? ''}): ${matches.length} matches`,
          );
        }
      }
      expect(failures).toEqual([]);
    },
  );

  it('gives shadow and frame rows a usable locator when a unique form exists', async () => {
    const model = await buildPageModel(recordedDeps(loadRecording('shadow')));
    const rows = (await generatedLocators(model)).filter(
      (entry) => entry.source === 'row',
    );
    const locatorFor = (id: string): string | undefined =>
      rows.find((entry) => entry.node.attributes.id === id)?.locator;
    expect(locatorFor('note')).toBe("page.locator('input#note')");
    expect(locatorFor('deep')).toBe(
      "page.getByRole('button', { name: 'Two levels deep' })",
    );
    const frames = await buildPageModel(recordedDeps(loadRecording('frames')));
    const frameRows = (await generatedLocators(frames)).filter(
      (entry) => entry.source === 'row',
    );
    expect(
      frameRows.find((entry) => entry.node.attributes.id === 'nested-button')
        ?.locator,
    ).toBe(
      "page.frameLocator('iframe#framed').frameLocator('iframe#nested').getByRole('button', { name: 'Nested action' })",
    );
  });
});

describe('rows without a unique locator form (major 3)', () => {
  it('emits no locator when every candidate matches in more than one scope', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const root = treeRoot(recording);
    for (const [hostId, id] of [
      ['open-host', 9301],
      ['closed-host', 9302],
    ] as const) {
      const host = findTreeNode(root, (node) =>
        hasAttribute(node, 'id', hostId),
      );
      const shadowRoot = childList(host, 'shadowRoots')[0];
      if (!shadowRoot) throw new Error('Missing shadow root');
      appendChild(shadowRoot, elementRecord(id, 'em', { tabindex: '0' }, []));
    }
    const model = await buildPageModel(
      recordedDeps(recording, {
        readStyles: (_frameId, _sessionId, ids) =>
          Promise.resolve(
            ids.map(() => ({ display: 'inline', visibility: 'visible' })),
          ),
      }),
    );
    const rows = projectInputSnapshot(
      model,
      { browserId: 'locators', limit: 100 },
      { browserId: 'locators', url: '', title: '' },
    ).inputs.filter((row) => row.tagName === 'em');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.locator).toBeUndefined();
      expect(row.ref).toMatch(/^r-/);
      const identity = model.registry.resolveRef(row.ref);
      if (!identity) throw new Error('Unresolvable ref');
      const inspected = await projectInspect(model, identity, {
        enrich: () => Promise.resolve(null),
      });
      expect(inspected?.locatorCandidates).toEqual([]);
      expect(inspected?.preferredLocator).toBeUndefined();
    }
  });
});
