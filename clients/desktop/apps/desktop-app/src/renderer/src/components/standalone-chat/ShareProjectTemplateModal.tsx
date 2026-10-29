import { type JSX, useCallback, useMemo } from 'react';
import { unwrapShareOperationResult } from '@/lib/sharing/share-operation-result';
import type {
  ChatProjectTemplateDocumentResult,
  ChatProjectTemplateShareInfo,
} from '@canopy/desktop-shared/types';
import type { PipelinePackageRef } from '@canopy/protocol/pipelines';
import { WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER } from '@canopy/protocol';
import {
  type CapabilityPackageSharePort,
  type ShareResourceExistingShare,
  type ShareResourceOutcome,
  type ShareResourceScope,
  type ShareResourceShareInput,
} from '@canopy/ui-app/sharing';
import { DesktopShareResourceDialog } from '@/components/shared/share/DesktopShareResourceDialog';
import {
  createShareLinkResolver,
  resolveSharedSkillUrl,
} from '@/lib/share-links';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';

const SHARE_SCOPES: readonly ShareResourceScope[] = [
  'team',
  'organization',
  'public',
];
const templateLinks = createShareLinkResolver(
  (id) => `/portal/plugins/project-templates/${encodeURIComponent(id)}`,
  resolveSharedSkillUrl,
);

interface ShareProjectTemplateModalProps {
  projectId: string;
  built: ChatProjectTemplateDocumentResult;
  existing: ChatProjectTemplateShareInfo | null;
  onShared: (share: ChatProjectTemplateShareInfo) => void;
  onRevoked: () => void;
  onClose: () => void;
}

function scopeFor(
  audience: ChatProjectTemplateShareInfo['audience'],
): 'team' | 'organization' | 'public' {
  if (audience === 'TEAM') return 'team';
  if (audience === 'ORGANIZATION') return 'organization';
  return 'public';
}

/** Common three-audience share flow for a desktop project-template draft. */
export function ShareProjectTemplateModal({
  projectId,
  built,
  existing,
  onShared,
  onRevoked,
  onClose,
}: ShareProjectTemplateModalProps): JSX.Element {
  useCurrentUiStateReporter('sharing.projectTemplateDialog', {
    open: true,
    projectId,
  });
  const packagePort = useMemo(
    (): CapabilityPackageSharePort => ({
      analyze: ({ dismissedInvocations }) =>
        window.api.chatProject.analyzeTemplateCapabilityPackage({
          projectId,
          document: built.document,
          ...(dismissedInvocations !== undefined
            ? { dismissedInvocations: [...dismissedInvocations] }
            : {}),
        }),
      cancel: (analysisId) =>
        window.api.chatProject.cancelTemplateCapabilityPackageAnalysis(
          analysisId,
        ),
    }),
    [built.document, projectId],
  );

  const share = useCallback(
    async (input: ShareResourceShareInput): Promise<ShareResourceOutcome> => {
      const selection = input.packageSelection;
      let capabilityPackage: PipelinePackageRef | undefined;
      let committedPackageUploadId: string | undefined;
      if (selection) {
        const committed = unwrapShareOperationResult(
          await window.api.chatProject.commitTemplateCapabilityPackage({
            analysisId: selection.analysisId,
            selectedOptionalResourceIds: [
              ...selection.selectedOptionalResourceIds,
            ],
          }),
        );
        capabilityPackage = committed.capabilityPackage;
        committedPackageUploadId = committed.committedPackageUploadId;
      }
      const detail = unwrapShareOperationResult(
        await window.api.chatProject.publishTemplateShare({
          projectId,
          document: built.document,
          audience:
            input.scope === 'team'
              ? 'TEAM'
              : input.scope === 'organization'
                ? 'ORGANIZATION'
                : 'PUBLIC',
          ...(input.teamId ? { teamId: input.teamId } : {}),
          ...(input.organizationId
            ? { organizationId: input.organizationId }
            : {}),
          ...(selection === null
            ? { capabilityPackage: null }
            : capabilityPackage
              ? { capabilityPackage }
              : {}),
          ...(committedPackageUploadId ? { committedPackageUploadId } : {}),
        }),
      );
      onShared(detail);
      const link = await templateLinks.resolveLink(
        input.scope === 'public'
          ? { kind: 'public', sharePath: detail.sharePath }
          : { kind: 'scoped', id: detail.externalId },
      );
      return { shareUrl: link.url };
    },
    [built.document, onShared, projectId],
  );

  const revoke = useCallback(async (): Promise<void> => {
    await window.api.chatProject.revokeTemplateShare({ projectId });
    onRevoked();
  }, [onRevoked, projectId]);

  const existingShare = useMemo((): ShareResourceExistingShare | undefined => {
    if (!existing) return undefined;
    const audience = scopeFor(existing.audience);
    const owner = existing.owner;
    return {
      audience,
      ...(audience !== 'public' &&
      owner &&
      (owner.type === 'team' || owner.type === 'organization')
        ? {
            target: {
              id: owner.id,
              name:
                owner.name ??
                (audience === 'team' ? 'Current team' : 'Organization'),
              ...('organization' in owner && owner.organization
                ? { organizationId: owner.organization.id }
                : {}),
            },
            targetAudience: audience,
          }
        : {}),
      ...(audience === 'public' && !existing.upToDate
        ? { publicLinkStale: true }
        : {}),
    };
  }, [existing]);

  return (
    <DesktopShareResourceDialog
      resourceNoun={WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER}
      testIdPrefix="share-project-template"
      requiredCapability="workspace-templates-v1"
      scopes={SHARE_SCOPES}
      landing="marketplace"
      subtitle={built.document.name}
      capabilityPackage={{
        port: packagePort,
        bindingLabelFor: (): null => null,
      }}
      {...(existingShare ? { existingShare } : {})}
      share={share}
      {...(existingShare?.audience === 'public'
        ? { revokePublicLink: revoke }
        : {})}
      onClose={onClose}
    />
  );
}
