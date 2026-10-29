import { ResourceContextUnavailableError } from '../lib/resource-context-error';
import {
  IPC_CHANNELS,
  type DeepLinkResolveShareResponse,
} from '@canopy/desktop-shared/types';
import {
  isPipelineContentHash,
  isPipelinePackageDigest,
} from '@canopy/protocol/pipelines';
import { isWorkspaceTemplateContentHash } from '@canopy/protocol/workspace-templates';
import { isSharedAutomationContentHash } from '@canopy/protocol/automations';
import { isCuratedCatalogKey } from '@canopy/protocol/plugin-catalog';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  getPublicPipelineShareSnapshot,
  getPublicPluginShareSnapshot,
  getPublicSkillShareSnapshot,
  getPublicAgentShareSnapshot,
  getPublicAutomationShareSnapshot,
  getPublicWorkspaceTemplateSnapshot,
  getPublicCollectionShareSnapshot,
  getScopedCollectionShareSnapshot,
  getScopedAgentShareSnapshot,
  getScopedPluginShareSnapshot,
  getScopedSkillShareSnapshot,
  type PublicPipelineSharePin,
} from '../canopy-cloud/public-share-client';
import { reportShareHandoffEvent } from '../canopy-cloud/share-handoff-events';
import { getSharedAutomation } from '../automations/canopy-server-client';
import { getCuratedAutomation } from '../automations/curated-automation-catalog';
import { registerIpcHandler } from './register';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Structural narrowing for the pipeline install pin the renderer forwards from
 * the parsed deep link. IPC payloads are untrusted, and the pin is only ever
 * sent onward when every present field is individually well-formed, so a
 * malformed pin degrades to an unpinned resolve rather than a bogus query.
 */
function parseInstallPin(request: object): PublicPipelineSharePin {
  const pin: PublicPipelineSharePin = {};
  const contentHash: unknown = Reflect.get(
    request,
    'expectedPipelineContentHash',
  );
  if (isPipelineContentHash(contentHash))
    pin.expectedPipelineContentHash = contentHash;
  const mode: unknown = Reflect.get(request, 'expectedDistributionMode');
  if (mode === 'package' || mode === 'definition_only')
    pin.expectedDistributionMode = mode;
  const digest: unknown = Reflect.get(request, 'expectedPackageDigest');
  if (isPipelinePackageDigest(digest)) pin.expectedPackageDigest = digest;
  return pin;
}

function parseWorkspaceTemplateInstallPin(request: object): string | undefined {
  const contentHash: unknown = Reflect.get(
    request,
    'expectedWorkspaceTemplateContentHash',
  );
  return isWorkspaceTemplateContentHash(contentHash) ? contentHash : undefined;
}

function parseAutomationInstallPin(request: object): string | undefined {
  const contentHash: unknown = Reflect.get(
    request,
    'expectedAutomationContentHash',
  );
  return isSharedAutomationContentHash(contentHash) ? contentHash : undefined;
}

async function getScopedAutomationShareSnapshot(
  externalId: string,
  expectedContentHash: string | undefined,
): Promise<Extract<DeepLinkResolveShareResponse, { ok: true }>['snapshot']> {
  const detail = await getSharedAutomation(externalId);
  if (
    expectedContentHash !== undefined &&
    detail.contentHash !== expectedContentHash
  ) {
    throw new CanopyCloudClientError(
      'http-error',
      'This shared automation changed.',
      409,
      'automation_share_changed',
    );
  }
  return {
    entity: 'automation',
    externalId: detail.id,
    automation: detail.automation,
    contentHash: detail.contentHash,
    distributionMode:
      detail.automation.capabilityPackage === undefined
        ? 'definition_only'
        : 'package',
    authorUsername: null,
    updatedAt: detail.updatedAt,
  };
}

async function getCuratedAutomationSnapshot(
  key: string,
  expectedContentHash: string | undefined,
): Promise<Extract<DeepLinkResolveShareResponse, { ok: true }>['snapshot']> {
  const detail = await getCuratedAutomation(key);
  if (
    expectedContentHash !== undefined &&
    detail.contentHash !== expectedContentHash
  ) {
    throw new CanopyCloudClientError(
      'http-error',
      'This curated automation changed.',
      409,
      'automation_share_changed',
    );
  }
  return {
    entity: 'automation',
    externalId: detail.key,
    sourceKind: 'curated',
    automation: detail.automation,
    contentHash: detail.contentHash,
    distributionMode:
      detail.package === undefined ? 'definition_only' : 'package',
    ...(detail.package === undefined ? {} : { package: detail.package }),
    authorUsername: null,
    updatedAt: detail.updatedAt,
  };
}

/**
 * Resolves a deep-linked public share to its pinned snapshot for the landing
 * modal (CAN-2361). The renderer holds the parsed deep-link payload, so this
 * re-validates the id shape, forwards the reviewed pipeline install pin, and
 * collapses failures to a typed result: `not-found` for unknown/revoked
 * shares (uniform 404 from the web), `client-upgrade-required` for a package
 * share this build cannot install (426), `share-changed` when the share was
 * republished after the recipient reviewed it (409
 * `pipeline_share_changed`), and `cloud-unreachable` for everything else.
 */
export async function resolveShareSnapshot(
  request: unknown,
): Promise<DeepLinkResolveShareResponse> {
  // IPC payloads are untrusted: narrow structurally instead of trusting the
  // renderer-declared type.
  if (typeof request !== 'object' || request === null) {
    return { ok: false, reason: 'not-found' };
  }
  const entity: unknown = Reflect.get(request, 'entity');
  const externalId: unknown = Reflect.get(request, 'externalId');
  const audience: unknown = Reflect.get(request, 'audience');
  const automationSource: unknown = Reflect.get(request, 'automationSource');
  const curatedAutomation =
    entity === 'automation' && automationSource === 'curated';
  if (
    (entity !== 'skill' &&
      entity !== 'pipeline' &&
      entity !== 'plugin' &&
      entity !== 'agent' &&
      entity !== 'automation' &&
      entity !== 'collection' &&
      entity !== 'workspace') ||
    typeof externalId !== 'string' ||
    (curatedAutomation
      ? !isCuratedCatalogKey(externalId)
      : !UUID_PATTERN.test(externalId)) ||
    (automationSource !== undefined && !curatedAutomation)
  ) {
    return { ok: false, reason: 'not-found' };
  }

  try {
    const snapshot =
      entity === 'skill'
        ? audience === 'TEAM' || audience === 'ORGANIZATION'
          ? await getScopedSkillShareSnapshot(externalId)
          : await getPublicSkillShareSnapshot(externalId)
        : entity === 'pipeline'
          ? await getPublicPipelineShareSnapshot(
              externalId,
              parseInstallPin(request),
            )
          : entity === 'plugin'
            ? audience === 'TEAM' || audience === 'ORGANIZATION'
              ? await getScopedPluginShareSnapshot(externalId)
              : await getPublicPluginShareSnapshot(externalId)
            : entity === 'automation'
              ? curatedAutomation
                ? await getCuratedAutomationSnapshot(
                    externalId,
                    parseAutomationInstallPin(request),
                  )
                : audience === 'TEAM' || audience === 'ORGANIZATION'
                  ? await getScopedAutomationShareSnapshot(
                      externalId,
                      parseAutomationInstallPin(request),
                    )
                  : await getPublicAutomationShareSnapshot(
                      externalId,
                      parseAutomationInstallPin(request),
                    )
              : entity === 'workspace'
                ? await getPublicWorkspaceTemplateSnapshot(
                    externalId,
                    parseWorkspaceTemplateInstallPin(request),
                  )
                : entity === 'collection'
                  ? audience === 'TEAM' || audience === 'ORGANIZATION'
                    ? await getScopedCollectionShareSnapshot(externalId)
                    : await getPublicCollectionShareSnapshot(externalId)
                  : audience === 'TEAM' || audience === 'ORGANIZATION'
                    ? await getScopedAgentShareSnapshot(externalId)
                    : await getPublicAgentShareSnapshot(externalId);
    if (snapshot.entity === 'collection') {
      const expectedHash: unknown = Reflect.get(
        request,
        'expectedCollectionContentHash',
      );
      const expectedDigest: unknown = Reflect.get(
        request,
        'expectedPackageDigest',
      );
      const expectedMode: unknown = Reflect.get(
        request,
        'expectedDistributionMode',
      );
      if (
        (expectedHash !== undefined && expectedHash !== snapshot.contentHash) ||
        (expectedDigest !== undefined &&
          expectedDigest !== snapshot.package?.digest) ||
        (expectedMode !== undefined &&
          expectedMode !== (snapshot.package ? 'package' : 'definition_only'))
      ) {
        return { ok: false, reason: 'share-changed' };
      }
    }
    return { ok: true, snapshot };
  } catch (error) {
    if (error instanceof ResourceContextUnavailableError)
      return { ok: false, reason: 'not-found' };
    if (
      error instanceof CanopyCloudClientError &&
      error.code === 'http-error'
    ) {
      if (error.status === 404) return { ok: false, reason: 'not-found' };
      // `426` is the web's package-capability gate. This build has no package
      // installer, so it is surfaced as an upgrade prompt and must never fall
      // through to a definition-only install of a package share.
      if (error.status === 426)
        return { ok: false, reason: 'client-upgrade-required' };
      if (
        error.status === 409 &&
        (error.serverCode === 'pipeline_share_changed' ||
          error.serverCode === 'workspace_template_share_changed' ||
          error.serverCode === 'automation_share_changed')
      )
        return { ok: false, reason: 'share-changed' };
    }
    return { ok: false, reason: 'cloud-unreachable' };
  }
}

/** Structural narrowing for the renderer-reported funnel legs. */
export function parseHandoffEventRequest(request: unknown): {
  entity:
    | 'skill'
    | 'pipeline'
    | 'plugin'
    | 'agent'
    | 'workspace'
    | 'collection'
    | 'automation';
  externalId: string;
  eventType: 'INSTALLED' | 'TRY_NOW';
  audience?: 'TEAM' | 'ORGANIZATION';
} | null {
  const isObject = typeof request === 'object' && request !== null;
  const entity: unknown = isObject ? Reflect.get(request, 'entity') : undefined;
  const externalId: unknown = isObject
    ? Reflect.get(request, 'externalId')
    : undefined;
  const eventType: unknown = isObject
    ? Reflect.get(request, 'eventType')
    : undefined;
  const audience: unknown = isObject
    ? Reflect.get(request, 'audience')
    : undefined;
  if (
    (entity !== 'skill' &&
      entity !== 'pipeline' &&
      entity !== 'plugin' &&
      entity !== 'agent' &&
      entity !== 'workspace' &&
      entity !== 'collection' &&
      entity !== 'automation') ||
    typeof externalId !== 'string' ||
    !UUID_PATTERN.test(externalId) ||
    (eventType !== 'INSTALLED' && eventType !== 'TRY_NOW') ||
    (audience !== undefined &&
      audience !== 'TEAM' &&
      audience !== 'ORGANIZATION')
  ) {
    return null;
  }
  return {
    entity,
    externalId,
    eventType,
    ...(audience !== undefined ? { audience } : {}),
  };
}

export function registerDeepLinkHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.deepLinkResolveShare, (_event, request) =>
    resolveShareSnapshot(request),
  );
  registerIpcHandler(
    IPC_CHANNELS.deepLinkReportHandoffEvent,
    (_event, request): void => {
      const parsed = parseHandoffEventRequest(request);
      if (!parsed) return;
      // Fire-and-forget by contract; the reporter itself never throws.
      void reportShareHandoffEvent(parsed);
    },
  );
}
