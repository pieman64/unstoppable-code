/**
 * Every locator string the model hands out for a page: each snapshot row's
 * `locator` and each inspect locator candidate. The recorder evaluates them
 * against real Chromium so the round-trip test can replay the answers.
 */
import type { BrowserPageModel, PageModelNode } from '../../model-types';
import { projectInputSnapshot, projectInspect } from '../../projections';

export interface GeneratedLocator {
  node: PageModelNode;
  locator: string;
  source: 'row' | 'inspect';
}

const PAGE = { browserId: 'locators', url: '', title: '' };

export async function generatedLocators(
  model: BrowserPageModel,
): Promise<GeneratedLocator[]> {
  const generated: GeneratedLocator[] = [];
  const byIdentity = new Map<string, PageModelNode>();
  for (const node of model.nodes) {
    byIdentity.set(
      JSON.stringify([node.identity.frameId, node.identity.backendNodeId]),
      node,
    );
  }
  for (let offset = 0; ; offset += 100) {
    const page = projectInputSnapshot(
      model,
      { browserId: 'locators', offset, limit: 100 },
      PAGE,
    );
    for (const row of page.inputs) {
      const identity = model.registry.resolveRef(row.ref);
      const node = identity
        ? byIdentity.get(
            JSON.stringify([identity.frameId, identity.backendNodeId]),
          )
        : undefined;
      if (node && row.locator !== undefined) {
        generated.push({ node, locator: row.locator, source: 'row' });
      }
    }
    if (!page.truncated) break;
  }
  for (const node of model.nodes) {
    if (node.nodeType !== 1) continue;
    const inspected = await projectInspect(model, node.identity, {
      enrich: () => Promise.resolve(null),
    });
    for (const candidate of inspected?.locatorCandidates ?? []) {
      generated.push({
        node,
        locator: candidate.playwright ?? candidate.value,
        source: 'inspect',
      });
    }
  }
  return generated;
}
