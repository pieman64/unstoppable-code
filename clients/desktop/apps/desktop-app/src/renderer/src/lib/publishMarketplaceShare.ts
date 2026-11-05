import type { SharedLinkKind, SharedByYouFacts } from '@canopy/ui-app/sharing';

/** Existing publish ports have two response envelopes; a resolved failure must reject. */
export async function publishMarketplaceShare(
  kind: SharedLinkKind,
  itemId: string,
): Promise<NonNullable<SharedByYouFacts['publicShare']>> {
  switch (kind) {
    case 'skill':
      return window.skills.publishPublicShare(itemId);
    case 'agent': {
      const result = await window.agents.publishPublicShare(itemId);
      window.dispatchEvent(new Event('canopy:shared-agents-changed'));
      window.dispatchEvent(new Event('canopy:agent-public-share-changed'));
      return result;
    }
    case 'collection':
      return window.collections.publishPublicShare(itemId);
    case 'automation': {
      const result = await window.api.automations.publishPublicShare(itemId);
      window.dispatchEvent(new Event('canopy:automation-public-share-changed'));
      return result;
    }
    case 'pipeline': {
      const result = await window.pipelines.publishPublicShare(itemId);
      if (!result.success || !result.data)
        throw new Error(result.error ?? 'Couldn’t update the public link.');
      window.dispatchEvent(new Event('canopy:pipeline-public-share-changed'));
      return result.data;
    }
    case 'plugin': {
      const result = await window.plugins.publishPublicShare(itemId);
      if (!result.success || !result.data)
        throw new Error(result.error ?? 'Couldn’t update the public link.');
      window.dispatchEvent(new Event('canopy:shared-plugins-changed'));
      return result.data;
    }
  }
}
