import { useResourceContext } from '@canopy/ui-app/capability';
import { useEffect, useMemo, useState, type JSX } from 'react';
import { RelatedItemsSection } from '@canopy/ui-shared';
import {
  DetailPageActions,
  ExecutionActionButton,
} from '@canopy/ui-shared/components';
import { McpServerLogo } from '../shared/McpServerLogo';
import { useInstalledMarketplaces } from '@/hooks/useInstalledMarketplaces';
import { useActiveWorktreeCwd } from '@/hooks/useActiveWorktreeCwd';
import {
  findRelatedCapabilitiesForPipeline,
  pipelineRefsKey,
} from '@/lib/relatedCapabilities';
import { PIPELINE_SOURCE_META } from './pipeline-source-meta';
import { TRIGGER_META } from './pipeline-trigger-meta';
import {
  PIPELINE_EXECUTION_SCOPE_BADGE_CLASS,
  PIPELINE_EXECUTION_SCOPE_META,
} from './pipeline-execution-scope-meta';
import {
  getPipelineScopeBadgeLabel,
  getPipelineScopeBadgeTooltipLines,
} from './pipeline-scope-badge-helpers';
import type {
  PipelineCapabilityRefsEntry,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';

interface PipelineCatalogDetailProps {
  pipeline: PipelineInfo;
  onOpenEditor: () => void;
  onOpenEntry?: (entryId: string) => void;
}

/** Read-only Marketplace summary for a pipeline before entering its editor. */
export function PipelineCatalogDetail({
  pipeline,
  onOpenEditor,
  onOpenEntry,
}: PipelineCatalogDetailProps): JSX.Element {
  const [refs, setRefs] = useState<PipelineCapabilityRefsEntry | null>(null);
  const [refsLoading, setRefsLoading] = useState(true);
  const cwd = useActiveWorktreeCwd();
  const { marketplaces, loading: marketplacesLoading } =
    useInstalledMarketplaces();

  useEffect(() => {
    let cancelled = false;
    const request = window.pipelines.listCapabilityRefs(
      cwd ? { cwd } : undefined,
    );
    void request
      .then((result) => {
        if (!cancelled && result.success && result.data) {
          setRefs(
            result.data.pipelines.find(
              (candidate) =>
                pipelineRefsKey(candidate) === pipelineRefsKey(pipeline),
            ) ?? null,
          );
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setRefsLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [cwd, pipeline]);

  const relatedCapabilities = useMemo(
    () =>
      findRelatedCapabilitiesForPipeline(
        refs?.capabilities ?? [],
        marketplaces,
      ),
    [marketplaces, refs],
  );
  const { personalOrganizationId } = useResourceContext();
  const sharedLines =
    pipeline.source === 'shared'
      ? [
          getPipelineScopeBadgeLabel(
            pipeline.shareScope,
            pipeline.owner,
            personalOrganizationId,
          ),
          ...getPipelineScopeBadgeTooltipLines(
            pipeline.shareScope,
            pipeline.owner,
            personalOrganizationId,
          ).filter(
            (line) =>
              line !==
              getPipelineScopeBadgeLabel(
                pipeline.shareScope,
                pipeline.owner,
                personalOrganizationId,
              ),
          ),
        ]
      : [];
  const scopes = pipeline.scopes ?? ['directory'];

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto"
      data-testid="pipeline-catalog-detail"
    >
      <div className="flex items-start gap-3">
        <McpServerLogo
          size={40}
          fallback="monogram"
          name={pipeline.name}
          shape="circle"
          fit="contain"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold fg-primary">
            {pipeline.name}
          </h2>
          <p className="mt-0.5 text-xs fg-secondary">
            {PIPELINE_SOURCE_META[pipeline.source].label}
            {sharedLines.map((line) => ` · ${line}`).join('')}
          </p>
        </div>
        <DetailPageActions
          primary={
            <ExecutionActionButton
              label="Open in editor"
              ariaLabel="Open in editor"
              variant="primary"
              placement="detail"
              onClick={onOpenEditor}
              dataTestId="pipeline-catalog-open-editor"
              stopKeyDownPropagation={false}
            />
          }
        />
      </div>

      {pipeline.description && (
        <p className="text-sm fg-secondary">{pipeline.description}</p>
      )}

      <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
        <MetadataBadges
          label="Triggers"
          values={(pipeline.triggerTypes ?? []).map(
            (type) => TRIGGER_META[type].label,
          )}
          empty="No trigger information"
        />
        <MetadataBadges
          label="Scopes"
          values={scopes.map(
            (scope) => PIPELINE_EXECUTION_SCOPE_META[scope].label,
          )}
          empty="No scope information"
        />
      </div>

      <RelatedItemsSection
        title="Related skills and plugins"
        emptyLabel="No related skills or plugins yet."
        loading={refsLoading || marketplacesLoading}
        testId="pipeline-catalog-related-capabilities-section"
        items={relatedCapabilities.map((item) => ({
          key: item.key,
          title: item.title,
          subtitle: item.subtitle,
          badge: item.kind === 'skill' ? 'Skill' : 'Plugin',
          reason: item.reason,
          onOpen: (): void => onOpenEntry?.(item.entryId),
        }))}
      />
    </div>
  );
}

function MetadataBadges({
  label,
  values,
  empty,
}: {
  label: string;
  values: string[];
  empty: string;
}): JSX.Element {
  return (
    <section>
      <h3 className="text-xs font-medium fg-primary">{label}</h3>
      {values.length === 0 ? (
        <p className="mt-1 text-xs fg-secondary">{empty}</p>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {values.map((value) => (
            <span key={value} className={PIPELINE_EXECUTION_SCOPE_BADGE_CLASS}>
              {value}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
