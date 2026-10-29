import { type JSX, useCallback, useRef, useState } from 'react';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type {
  CollectionConfig,
  CollectionIndexEntry,
} from '@canopy/desktop-shared/types/collections';
import type {
  PipelineData,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { ShareAgentModal } from '@/components/agents/ShareAgentModal';
import { ShareAutomationModal } from '@/components/automations/ShareAutomationModal';
import { ShareCollectionModal } from '@/components/collections/ShareCollectionModal';
import { SharePipelineModal } from '@/components/pipeline/SharePipelineModal';
import { ShareSkillModal } from '@/components/skills/ShareSkillModal';
import type { ShareAction, ShareActionKind } from '@/hooks/useShareAction';
import { fetchPipelineDocument } from '@/lib/pipelineDocument';
import { postShareToast } from '@/lib/share-toast';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';
import type { UnifiedPluginEntry } from '@/lib/unifiedPluginEntries';

/**
 * Sharing for the Marketplace entries a user owns: their skills, pipelines,
 * automations, collections and local agents. Each kind already has a share dialog on its
 * own page; this resolves an entry back to the object that dialog shares and
 * opens the same dialog here, so Share works from the Marketplace row and
 * detail as it does from the Skills, Pipelines, Automations and Collections
 * lists.
 */

/** The local object a Marketplace entry shares. */
export type OwnedShareTarget =
  | {
      kind: 'skill';
      skill: Pick<InstalledSkillInfo, 'sourceId' | 'name' | 'remote'>;
    }
  | { kind: 'collection'; collectionId: string }
  | { kind: 'pipeline'; info: PipelineInfo }
  | { kind: 'automation'; activity: ScheduledActivity }
  | { kind: 'agent'; agent: AgentModelDefinition };

export interface OwnedShareSources {
  skills: readonly InstalledSkillInfo[];
  localCollections: readonly CollectionIndexEntry[];
  pipelines: readonly PipelineInfo[];
  automationActivities: readonly ScheduledActivity[];
  /** Local agent definitions; omitted while the Agents flag is off. */
  localAgents?: readonly AgentModelDefinition[];
  /** The sidebar's Personal or organization context. */
  context: WorkspaceContext | undefined;
}

/**
 * The share target for an entry the user owns, or `null` when the entry is
 * not theirs to share from here. The rules match each kind's own page:
 *
 * - Skills: custom skills and the bundled built-ins (shared as a snapshot).
 *   Plugin-owned and externally installed skills are not shareable.
 * - Collections: every locally owned collection can open its share dialog.
 *   MCP-backed collections have a disabled Share action.
 * - Pipelines: stored and bundled pipelines. A project pipeline is shared
 *   from the Pipelines page, which knows the worktree its file lives in.
 * - Automations: every local automation except a usage-limit resume, which
 *   is bound to one local pipeline run.
 * - Agents: every local agent, as the retired Agents page allowed. The share
 *   dialog carries its own connection state.
 */
export function ownedShareTargetForEntry(
  entry: Pick<UnifiedPluginEntry, 'ref'>,
  sources: OwnedShareSources,
): OwnedShareTarget | null {
  const ref = entry.ref;
  if (ref.type === 'skill') {
    const skill = sources.skills.find(
      (candidate) =>
        candidate.sourceId === ref.sourceId && candidate.name === ref.skillName,
    );
    if (!skill) return null;
    const shareable =
      (skill.custom === true && skill.sourceId === 'custom:app') ||
      (skill.builtIn === true && skill.sourceId === 'builtin:app');
    if (!shareable) return null;
    return {
      kind: 'skill',
      skill: {
        sourceId: skill.sourceId,
        name: skill.name,
        ...(skill.remote ? { remote: skill.remote } : {}),
      },
    };
  }
  if (ref.type === 'local-collection') {
    const collection = sources.localCollections.find(
      (candidate) => candidate.id === ref.collectionId,
    );
    if (!collection) return null;
    return { kind: 'collection', collectionId: collection.id };
  }
  if (ref.type === 'pipeline') {
    if (ref.source !== 'user' && ref.source !== 'bundled') return null;
    const info = sources.pipelines.find(
      (candidate) =>
        candidate.id === ref.pipelineId && candidate.source === ref.source,
    );
    return info ? { kind: 'pipeline', info } : null;
  }
  if (ref.type === 'automation') {
    const activity = sources.automationActivities.find(
      (candidate) => candidate.id === ref.activityId,
    );
    if (!activity || activity.action.type === 'pipeline_execution_resume') {
      return null;
    }
    return { kind: 'automation', activity };
  }
  if (ref.type === 'local-agent') {
    const agent = sources.localAgents?.find(
      (candidate) => candidate.id === ref.agentId,
    );
    return agent ? { kind: 'agent', agent } : null;
  }
  return null;
}

type OpenShare =
  | {
      kind: 'skill';
      skill: Pick<InstalledSkillInfo, 'sourceId' | 'name' | 'remote'>;
    }
  | { kind: 'collection'; collection: CollectionConfig }
  | { kind: 'pipeline'; document: PipelineData }
  | { kind: 'automation'; activity: ScheduledActivity }
  | { kind: 'agent'; agent: AgentModelDefinition };

export interface MarketplaceOwnedShareOptions {
  shareAction: ShareAction;
  onOpenAccountSettings: () => void;
  /** Reload the lists a completed share can change. */
  onSharedSkillsChanged: () => void;
  onSharedCollectionsChanged: () => void;
  onPipelinesChanged: () => void;
  /** Reload local and shared agents, so a new share dedupes at once. */
  onLocalAgentsChanged?: () => void;
  onSharedAgentsChanged?: () => void;
}

export interface MarketplaceOwnedShare {
  /** Starts sharing a target resolved by {@link ownedShareTargetForEntry}. */
  share: (target: OwnedShareTarget) => void;
  /** Whether the account can share this kind at all. */
  canShare: (kind: OwnedShareTarget['kind']) => boolean;
  /** The open share dialog, if any. Render once in the host. */
  shareModal: JSX.Element | null;
  /** The kind whose dialog is open, so the host can dismiss a retired kind. */
  openKind: OwnedShareTarget['kind'] | null;
  /** Dismisses the open dialog and any pending request. */
  close: () => void;
}

const SHARE_ACTION_KIND: Record<OwnedShareTarget['kind'], ShareActionKind> = {
  skill: 'skill',
  collection: 'collection',
  pipeline: 'pipeline',
  automation: 'automation',
  agent: 'agent',
};

export function useMarketplaceOwnedShare({
  shareAction,
  onOpenAccountSettings,
  onSharedSkillsChanged,
  onSharedCollectionsChanged,
  onPipelinesChanged,
  onLocalAgentsChanged,
  onSharedAgentsChanged,
}: MarketplaceOwnedShareOptions): MarketplaceOwnedShare {
  const [open, setOpen] = useState<OpenShare | null>(null);
  // A collection or pipeline loads before its dialog opens. Only the latest
  // request may open one, so two quick Share clicks never stack dialogs.
  const requestSeq = useRef(0);

  const openTarget = useCallback((target: OwnedShareTarget): void => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    if (target.kind === 'skill') {
      setOpen({ kind: 'skill', skill: target.skill });
      return;
    }
    if (target.kind === 'automation') {
      setOpen({ kind: 'automation', activity: target.activity });
      return;
    }
    if (target.kind === 'agent') {
      setOpen({ kind: 'agent', agent: target.agent });
      return;
    }
    const failed = (reason: string): void => {
      if (requestSeq.current !== seq) return;
      postShareToast({
        tone: 'warning',
        message: `Couldn't open sharing. ${reason}`.trim(),
      });
    };
    if (target.kind === 'collection') {
      window.collections
        .loadCollection(target.collectionId)
        .then((collection) => {
          if (requestSeq.current !== seq) return;
          if (!collection) {
            failed('Collection not found.');
            return;
          }
          setOpen({ kind: 'collection', collection });
        })
        .catch((error: unknown) => {
          failed(resolveSharedResourceErrorMessage(error));
        });
      return;
    }
    fetchPipelineDocument(target.info)
      .then((loaded) => {
        if (requestSeq.current !== seq) return;
        if (loaded.error !== undefined) {
          failed(loaded.error);
          return;
        }
        setOpen({ kind: 'pipeline', document: loaded.data });
      })
      .catch((error: unknown) => {
        failed(resolveSharedResourceErrorMessage(error));
      });
  }, []);

  const share = useCallback(
    (target: OwnedShareTarget): void => {
      shareAction.share(SHARE_ACTION_KIND[target.kind], () =>
        openTarget(target),
      );
    },
    [openTarget, shareAction],
  );

  const canShare = useCallback(
    (kind: OwnedShareTarget['kind']): boolean =>
      shareAction.canShare(SHARE_ACTION_KIND[kind]),
    [shareAction],
  );

  const close = useCallback((): void => {
    requestSeq.current += 1;
    setOpen(null);
  }, []);

  let shareModal: JSX.Element | null = null;
  if (open?.kind === 'skill') {
    shareModal = (
      <ShareSkillModal
        skill={open.skill}
        onClose={close}
        onOpenAccountSettings={onOpenAccountSettings}
        onPublicLinkRemoved={onSharedSkillsChanged}
        onShared={(): void => {
          onSharedSkillsChanged();
          close();
        }}
      />
    );
  } else if (open?.kind === 'collection') {
    shareModal = (
      <ShareCollectionModal
        collection={open.collection}
        onClose={close}
        onOpenAccountSettings={onOpenAccountSettings}
        onShared={(): void => {
          onSharedCollectionsChanged();
          close();
        }}
      />
    );
  } else if (open?.kind === 'pipeline') {
    shareModal = (
      <SharePipelineModal
        pipeline={open.document.content}
        localPipelineInfo={open.document.info}
        onClose={close}
        onOpenAccountSettings={onOpenAccountSettings}
        onPublicLinkRemoved={onPipelinesChanged}
        onShared={(): void => {
          onPipelinesChanged();
          close();
        }}
      />
    );
  } else if (open?.kind === 'automation') {
    shareModal = (
      <ShareAutomationModal
        key={open.activity.id}
        activity={open.activity}
        onClose={close}
        onOpenAccountSettings={onOpenAccountSettings}
        onShared={(): void => {
          // Main persists the remote metadata and the automations store
          // refreshes from its broadcast; nothing to reload here.
        }}
      />
    );
  } else if (open?.kind === 'agent') {
    shareModal = (
      <ShareAgentModal
        agent={open.agent}
        onClose={close}
        onOpenAccountSettings={onOpenAccountSettings}
        // The dialog stays open on success to show the share's audience and
        // link, as it did on the Agents page.
        onShared={(): void => {
          onLocalAgentsChanged?.();
          onSharedAgentsChanged?.();
        }}
        onPublicLinkRemoved={(): void => {
          onLocalAgentsChanged?.();
          onSharedAgentsChanged?.();
        }}
      />
    );
  }

  return { share, canShare, shareModal, openKind: open?.kind ?? null, close };
}
