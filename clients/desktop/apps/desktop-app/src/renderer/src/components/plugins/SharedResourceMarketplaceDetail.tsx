import type { JSX, ReactNode } from 'react';
import type { SharedAgentSummary } from '@canopy/desktop-shared/types/agent-models';
import type { DeepLinkShareOpenEvent } from '@canopy/desktop-shared/types';
import type { SharedPluginSummary } from '@canopy/protocol/plugins';
import type { WorkspaceTemplateShareSummary } from '@canopy/protocol/workspace-templates';
import { shareablePluginSourceLabel } from '@canopy/desktop-shared/plugin-refs';
import {
  DetailPageActions,
  ExecutionActionButton,
} from '@canopy/ui-shared/components';
import {
  sharedBlueprintInstallLink,
  sharedResourceInstallLink,
} from '@/lib/sharedResourceInstallLink';
import { useNavigationStore } from '@/stores/navigationStore';

/**
 * Marketplace details for the kinds a recipient reaches only through a share:
 * an agent, a project template and a plugin reference. The page shell's
 * header (CAN-4266) says what each is, who shared it and with whom, from the
 * `*DetailHeader` builders in `sharedResourceDetailHeaders`; the body adds its facts and the one
 * `Install` action, which opens the shared install review (CAN-3710) and
 * lands on the result. An owner's Unshare lives in the header's ⋯ menu.
 */

/** Opens the install review for a shared resource listed in the app. */
function openInstallReview(link: DeepLinkShareOpenEvent): void {
  useNavigationStore.getState().openShareInstall(link, 'in-app');
}

/** The detail's one action: `Install`, when there is something to install. */
function InstallAction({
  link,
  name,
  testId,
}: {
  link: DeepLinkShareOpenEvent | null;
  name: string;
  testId: string;
}): JSX.Element | null {
  if (link === null) return null;
  return (
    <DetailPageActions
      primary={
        <ExecutionActionButton
          placement="detail"
          label="Install"
          ariaLabel={`Install ${name}`}
          variant="primary"
          onClick={(): void => openInstallReview(link)}
          dataTestId={testId}
          stopKeyDownPropagation={false}
        />
      }
    />
  );
}

function DetailFact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex gap-3 text-s">
      <dt className="w-28 shrink-0 fg-secondary">{label}</dt>
      <dd className="min-w-0 fg-primary">{children}</dd>
    </div>
  );
}

export interface SharedAgentMarketplaceDetailProps {
  agent: SharedAgentSummary;
}

/** A shared agent; Install opens the install review. */
export function SharedAgentMarketplaceDetail({
  agent,
}: SharedAgentMarketplaceDetailProps): JSX.Element {
  return (
    <div className="space-y-6" data-testid="shared-agent-marketplace-detail">
      <InstallAction
        link={sharedResourceInstallLink({
          entity: 'agent',
          externalId: agent.id,
          scope: agent.shareScope,
        })}
        name={agent.name}
        testId="shared-agent-detail-add"
      />
      {agent.instructionsPreview.trim() !== '' && (
        <dl className="space-y-2">
          <DetailFact label="Instructions">
            <span className="whitespace-pre-wrap">
              {agent.instructionsPreview}
            </span>
          </DetailFact>
        </dl>
      )}
    </div>
  );
}

export interface SharedBlueprintMarketplaceDetailProps {
  blueprint: WorkspaceTemplateShareSummary;
}

/** Member-authorized project-template detail and hash-pinned install flow. */
export function SharedBlueprintMarketplaceDetail({
  blueprint,
}: SharedBlueprintMarketplaceDetailProps): JSX.Element {
  return (
    <div
      className="space-y-6"
      data-testid="shared-blueprint-marketplace-detail"
    >
      <InstallAction
        link={sharedBlueprintInstallLink(blueprint)}
        name={blueprint.name}
        testId="shared-blueprint-detail-add"
      />
    </div>
  );
}

export interface SharedPluginMarketplaceDetailProps {
  plugin: SharedPluginSummary;
}

/**
 * A shared plugin reference. Nothing is copied with it: the share names a
 * plugin by its source, and Install installs that plugin from the local catalog.
 */
export function SharedPluginMarketplaceDetail({
  plugin,
}: SharedPluginMarketplaceDetailProps): JSX.Element {
  return (
    <div className="space-y-6" data-testid="shared-plugin-marketplace-detail">
      <InstallAction
        link={sharedResourceInstallLink({
          entity: 'plugin',
          externalId: plugin.externalId,
          scope: plugin.shareScope,
        })}
        name={plugin.name}
        testId="shared-plugin-detail-add"
      />
      <dl className="space-y-2">
        <DetailFact label="Source">
          {shareablePluginSourceLabel(plugin.ref)}
        </DetailFact>
      </dl>
      <p className="text-xs fg-secondary">
        Only a reference to this plugin is shared. Adding it installs the plugin
        from its source; credentials and configuration are yours to set up.
      </p>
    </div>
  );
}
