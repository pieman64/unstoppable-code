import { useEffect, useMemo, useState, type JSX } from 'react';
import { RelatedItemsSection } from '@canopy/ui-shared';
import { PIPELINE_SOURCE_META } from './pipeline-source-meta';
import {
  useNavigationStore,
  type EntryDetailReturnContext,
  type PipelineEditDeepLink,
  type PipelineReturnTarget,
} from '@/stores/navigationStore';
import { useActiveWorktreeCwd } from '@/hooks/useActiveWorktreeCwd';
import { useInstalledMarketplaces } from '@/hooks/useInstalledMarketplaces';
import {
  capabilitySimilarityKey,
  findRelatedCapabilitiesForPipeline,
  findSimilarPipelines,
  pipelineRefsKey,
  rawCapabilitySimilarityKey,
} from '@/lib/relatedCapabilities';
import { collectPipelineCapabilityRefs } from '@canopy/execution-engine/pipelines/plugin-collections';
import { getTriggerTypes } from '@canopy/execution-engine/types/pipeline';
import type {
  Pipeline,
  PipelineCapabilityRefsEntry,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';

interface RelatedPipelineSourceData {
  candidates: PipelineInfo[];
  refsEntries: PipelineCapabilityRefsEntry[];
  loading: boolean;
}

/**
 * Fetch every locally readable pipeline plus its capability summary. Shared
 * Cloud pipelines are excluded: their definitions require per-pipeline remote
 * fetches, and unavailable/unauthorized items must never be recommended.
 * Fail-soft on IPC errors (sections fall back to empty states).
 */
function useRelatedPipelineSources(
  cwd?: string,
  refreshKey = 0,
): RelatedPipelineSourceData {
  const [data, setData] = useState<Omit<RelatedPipelineSourceData, 'loading'>>({
    candidates: [],
    refsEntries: [],
  });
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    // Reset on cwd change so a worktree switch can't leave stale project
    // pipelines (or a stale filePath paired with the new cwd) on screen.
    setData({ candidates: [], refsEntries: [] });
    setLoading(true);
    void (async (): Promise<void> => {
      const candidates: PipelineInfo[] = [];
      let refsEntries: PipelineCapabilityRefsEntry[] = [];
      try {
        // Independent lookups — issue the IPC calls concurrently.
        const [stored, project, refs] = await Promise.all([
          window.pipelines.list(),
          cwd ? window.pipelines.discoverProject(cwd) : Promise.resolve(null),
          window.pipelines.listCapabilityRefs(cwd ? { cwd } : undefined),
        ]);
        if (stored.success && stored.data) {
          candidates.push(...stored.data);
        }
        if (project?.success && project.data) {
          candidates.push(...project.data);
        }
        if (refs.success && refs.data) {
          refsEntries = refs.data.pipelines;
        }
      } catch {
        // Sections fall back to their empty states.
      }
      if (!cancelled) {
        const readablePipelineKeys = new Set(
          refsEntries.map((entry) => pipelineRefsKey(entry)),
        );
        setData({
          candidates: candidates.filter((candidate) =>
            readablePipelineKeys.has(pipelineRefsKey(candidate)),
          ),
          refsEntries,
        });
        setLoading(false);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [cwd, refreshKey]);
  return { ...data, loading };
}

function editLinkForPipeline(
  info: Pick<PipelineInfo, 'id' | 'source' | 'filePath' | 'remoteId'>,
  cwd?: string,
): PipelineEditDeepLink {
  if (info.source === 'shared') {
    return { pipelineId: info.id, sharedRemoteId: info.remoteId };
  }
  if (info.source === 'project') {
    return { pipelineId: info.id, cwd, filePath: info.filePath };
  }
  // Carry the stored-catalog namespace: bundled and user pipelines can share
  // an id and bare-id lookups resolve user-before-bundled.
  return { pipelineId: info.id, source: info.source };
}

function returnTargetForPipeline(
  pipelineInfo: PipelineInfo,
  cwd?: string,
  returnContext?: Pick<
    PipelineReturnTarget,
    | 'returnToEntryId'
    | 'returnToEntryContext'
    | 'returnToPipeline'
    | 'returnToMarketplace'
  >,
): PipelineReturnTarget {
  return {
    pipelineId: pipelineInfo.id,
    ...(pipelineInfo.source === 'project'
      ? { cwd, filePath: pipelineInfo.filePath }
      : {}),
    ...(pipelineInfo.source === 'shared'
      ? { sharedRemoteId: pipelineInfo.remoteId }
      : {}),
    ...(pipelineInfo.source === 'bundled' || pipelineInfo.source === 'user'
      ? { source: pipelineInfo.source }
      : {}),
    ...(returnContext?.returnToEntryId
      ? { returnToEntryId: returnContext.returnToEntryId }
      : {}),
    ...(returnContext?.returnToEntryContext
      ? { returnToEntryContext: returnContext.returnToEntryContext }
      : {}),
    ...(returnContext?.returnToPipeline
      ? { returnToPipeline: returnContext.returnToPipeline }
      : {}),
    ...(returnContext?.returnToMarketplace
      ? { returnToMarketplace: returnContext.returnToMarketplace }
      : {}),
  };
}

interface PipelineRelatedSectionsProps {
  pipeline: Pipeline;
  pipelineInfo: PipelineInfo | null;
  /** Editor load-locator cwd — only set when viewing a project pipeline. */
  cwd?: string;
  /** Bumped only after a successful save so persisted summaries refetch. */
  refreshKey: number;
  /** Capability detail that opened the current editor, if any. */
  returnToEntryId?: string;
  /** Complete capability detail history that opened the current editor. */
  returnToEntryContext?: EntryDetailReturnContext;
  /** Earlier pipeline in the current recommendation chain, if any. */
  returnToPipeline?: PipelineReturnTarget;
  /** Marketplace discovery state behind the current pipeline. */
  returnToMarketplace?: PipelineReturnTarget['returnToMarketplace'];
  /** Editor-owned dirty/save guard for recommendation navigation. */
  onNavigate: (navigate: (savedPipelineInfo?: PipelineInfo) => void) => void;
}

/**
 * "Similar pipelines" and "Related skills and plugins" sections for the
 * pipeline detail surface (CAN-2382), rendered at the bottom of the pipeline
 * settings panel. Similarity is deterministic: shared declared capabilities
 * first, then shared trigger types, then name/description overlap. Related
 * capabilities are the pipeline's declared refs that resolve against the
 * installed catalog.
 */
export function PipelineRelatedSections({
  pipeline,
  pipelineInfo,
  cwd,
  refreshKey,
  returnToEntryId,
  returnToEntryContext,
  returnToPipeline,
  returnToMarketplace,
  onNavigate,
}: PipelineRelatedSectionsProps): JSX.Element {
  // The locator cwd is unset for bundled/user/shared pipelines, but project
  // pipelines from the active worktree should still surface as similar; fall
  // back to the page-level active worktree the same way the capability
  // surfaces do.
  const activeCwd = useActiveWorktreeCwd();
  const effectiveCwd = cwd ?? activeCwd;
  const { candidates, refsEntries, loading } = useRelatedPipelineSources(
    effectiveCwd,
    refreshKey,
  );
  const { marketplaces, loading: marketplacesLoading } =
    useInstalledMarketplaces();
  const openPipelineEdit = useNavigationStore((s) => s.openPipelineEdit);
  const openPluginsNavigation = useNavigationStore(
    (s) => s.openPluginsNavigation,
  );

  // Locator of the pipeline being viewed, used as the return target for
  // recommendation clicks so Back restores this pipeline (CAN-2382).
  // Unsaved drafts have no locator and simply skip the return context.
  const currentReturnTarget = useMemo(
    (): PipelineReturnTarget | undefined =>
      pipelineInfo
        ? returnTargetForPipeline(pipelineInfo, cwd, {
            returnToEntryId,
            returnToEntryContext,
            returnToPipeline,
            returnToMarketplace,
          })
        : undefined,
    [
      pipelineInfo,
      cwd,
      returnToEntryId,
      returnToEntryContext,
      returnToPipeline,
      returnToMarketplace,
    ],
  );

  // The current pipeline's declared refs come from the in-memory definition
  // so unsaved drafts still contribute to the similarity signal.
  const capabilityKeys = useMemo(() => {
    const persistedEntry = pipelineInfo
      ? refsEntries.find(
          (entry) =>
            entry.id === pipelineInfo.id &&
            entry.source === pipelineInfo.source,
        )
      : undefined;
    const persistedByRawKey = new Map(
      persistedEntry?.capabilities.map((capability) => [
        capability.key,
        capability,
      ]) ?? [],
    );
    return collectPipelineCapabilityRefs(pipeline).map((ref) => {
      const persistedCapability = persistedByRawKey.get(ref.key);
      return persistedCapability
        ? capabilitySimilarityKey(persistedCapability)
        : rawCapabilitySimilarityKey(ref.key);
    });
  }, [pipeline, pipelineInfo, refsEntries]);

  // Keyed by source-qualified pipeline identity: bundled/user/project
  // namespaces can reuse the same bare id.
  const refsByPipeline = useMemo(
    () =>
      new Map<string, readonly string[]>(
        refsEntries.map((entry) => [
          pipelineRefsKey(entry),
          entry.capabilities.map(capabilitySimilarityKey),
        ]),
      ),
    [refsEntries],
  );

  const similarPipelines = useMemo(
    () =>
      findSimilarPipelines(
        {
          info: {
            id: pipelineInfo?.id ?? '',
            source: pipelineInfo?.source ?? 'user',
            name: pipeline.name,
            description: pipeline.description ?? '',
            // Live triggers from the in-memory definition, so drafts and
            // unsaved edits score correctly.
            triggerTypes: getTriggerTypes(pipeline.on),
          },
          capabilityKeys,
        },
        candidates,
        refsByPipeline,
      ),
    [pipelineInfo, pipeline, capabilityKeys, candidates, refsByPipeline],
  );

  // Install-state resolution comes from the saved summary; a matched entry is
  // required for navigation, so drafts and unsaved collections list nothing.
  const relatedCapabilities = useMemo(() => {
    const entry = pipelineInfo
      ? refsEntries.find(
          (candidate) =>
            candidate.id === pipelineInfo.id &&
            candidate.source === pipelineInfo.source,
        )
      : undefined;
    return findRelatedCapabilitiesForPipeline(
      entry?.capabilities ?? [],
      marketplaces,
    );
  }, [pipelineInfo, refsEntries, marketplaces]);

  return (
    <>
      <RelatedItemsSection
        title="Similar workflows"
        emptyLabel="No similar workflows yet."
        loading={loading}
        testId="similar-pipelines-section"
        items={similarPipelines.map((item) => ({
          key: `${item.info.source}:${item.info.id}`,
          icon: item.info.icon,
          title: item.info.name,
          sourceLabel: PIPELINE_SOURCE_META[item.info.source].label,
          reason: item.reasons.join(' · '),
          onOpen: (): void => {
            onNavigate((savedPipelineInfo) => {
              openPipelineEdit({
                ...editLinkForPipeline(item.info, effectiveCwd),
                returnToPipeline: savedPipelineInfo
                  ? returnTargetForPipeline(savedPipelineInfo, cwd, {
                      returnToEntryId,
                      returnToEntryContext,
                      returnToPipeline,
                      returnToMarketplace,
                    })
                  : currentReturnTarget,
              });
            });
          },
        }))}
      />
      <RelatedItemsSection
        title="Related skills and plugins"
        emptyLabel="No related skills or plugins yet."
        loading={loading || marketplacesLoading}
        testId="pipeline-related-capabilities-section"
        items={relatedCapabilities.map((item) => ({
          key: item.key,
          title: item.title,
          subtitle: item.subtitle,
          badge: item.kind === 'skill' ? 'Skill' : 'Plugin',
          reason: item.reason,
          onOpen: (): void => {
            onNavigate((savedPipelineInfo) => {
              const returnTarget = savedPipelineInfo
                ? returnTargetForPipeline(savedPipelineInfo, cwd, {
                    returnToEntryId,
                    returnToEntryContext,
                    returnToPipeline,
                  })
                : currentReturnTarget;
              openPluginsNavigation({
                kind: 'entry-detail',
                entryId: item.entryId,
                ...(returnTarget
                  ? { from: { kind: 'pipeline', ...returnTarget } }
                  : {}),
              });
            });
          },
        }))}
      />
    </>
  );
}
