import { type JSX, useEffect, useState } from 'react';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import type { SkillContentResponse } from '@canopy/desktop-shared/types/skills';
import type {
  SkillDetailSelection,
  UnifiedTableDetailView,
} from './unifiedTableDetailView';
import { MarkdownFrontmatterContent } from '@canopy/ui-app';
import { PluginDetailView } from './PluginDetailView';
import { McpServerDetailOverlay } from './McpServersTab';
import { runCancellableModalLoad } from './entityEditModalUtils';
import { BackDetailOverlayShell } from './BackDetailOverlayShell';
import { readSkillContentForDisplay } from './skillContentUtils';

export function SkillDetailOverlay({
  skill,
  onBack,
}: {
  skill: SkillDetailSelection;
  onBack: () => void;
}): JSX.Element {
  const [content, setContent] = useState<SkillContentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    void runCancellableModalLoad(
      async (): Promise<void> => {
        const result = await readSkillContentForDisplay(skill);
        if (cancelled) return;
        setContent(result);
      },
      {
        isCancelled: () => cancelled,
        setError,
        setLoading,
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [skill]);

  return (
    <BackDetailOverlayShell
      title={skill.name}
      titleId="skill-detail-overlay-title"
      onBack={onBack}
      // The SKILL.md text is blocked below the title.
      blockContentFromReplay
    >
      <MarkdownFrontmatterContent
        loading={loading}
        error={error}
        content={content}
        emptyText="This skill has no content."
      />
    </BackDetailOverlayShell>
  );
}

export function PluginDetailOverlay({
  plugin,
  marketplace,
  onBack,
}: {
  plugin: PluginInfo;
  marketplace: MarketplaceInfo;
  onBack: () => void;
}): JSX.Element {
  const [displayPlugin, setDisplayPlugin] = useState(plugin);

  useEffect(() => {
    setDisplayPlugin(plugin);
  }, [plugin]);

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-overlay-scrim p-4"
      onClick={onBack}
    >
      {/* The shared plugin detail content blocks the README and component
          file text itself. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-detail-title"
        className="w-full max-w-3xl max-h-[80vh] flex flex-col rounded-2xl bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <PluginDetailView
            plugin={displayPlugin}
            marketplace={marketplace}
            onBack={onBack}
            onPluginUpdated={setDisplayPlugin}
          />
        </div>
      </div>
    </div>
  );
}

export function UnifiedTableDetailOverlays({
  details,
}: {
  details: UnifiedTableDetailView;
}): JSX.Element {
  return (
    <>
      {details.viewingSkill && (
        <SkillDetailOverlay
          skill={details.viewingSkill}
          onBack={() => details.setViewingSkill(null)}
        />
      )}

      {details.viewingPlugin && details.viewingPluginMarketplace && (
        <PluginDetailOverlay
          plugin={details.viewingPlugin}
          marketplace={details.viewingPluginMarketplace}
          onBack={() => details.setViewingPlugin(null)}
        />
      )}

      {details.viewingMcpServerId && (
        <McpServerDetailOverlay
          serverId={details.viewingMcpServerId}
          configId={details.viewingMcpConfigId ?? undefined}
          onBack={() => {
            details.setViewingMcpServerId(null);
            details.setViewingMcpConfigId(null);
          }}
        />
      )}
    </>
  );
}
