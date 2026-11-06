import { UpgradePersonalOrganizationRequestSchema } from '@canopy/protocol/organizations';
import {
  SettingsOperationError,
  settingsErrorCodeForStatus,
  settingsOperation,
  settingsOperationRequest,
  type SettingsOperationName,
} from '@canopy/protocol/settings';
import { ORGANIZATION_SETTINGS_OPERATIONS } from '@canopy/protocol/settings/operations-organization';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import type { PersonalOrganizationUpgradeService } from './personal-organization-upgrade';
import type {
  SettingsOrchestratedOperation,
  SettingsOrchestrationResolver,
  SettingsWriteFollowUp,
  SettingsWriteFollowUpResolver,
} from './account-organization-settings';

/**
 * Promotion of the Personal organization runs desktop orchestration after
 * the server call (suppressing the local upgrade prompt, refreshing the
 * account and switching the workspace context), so a settings table entry
 * that names the promotion route goes through the existing
 * {@link PersonalOrganizationUpgradeService} instead of a raw request.
 *
 * Matching is on the request the entry builds from validated input, not on
 * the entry's name, so the route stays bound to the orchestration whatever
 * the table calls it. Membership changes use the separate best-effort
 * follow-up below; project conversion is not a table entry.
 */
const PROMOTION_PATH =
  /^\/api\/(?:v1\/organizations|account\/organizations)\/([^/?#]+)\/upgrade$/;

function promotionOrganizationId(
  name: SettingsOperationName,
  validatedInput: unknown,
): string | null {
  const operation = settingsOperation(name);
  if (operation.kind !== 'write' || operation.transport !== 'backend')
    return null;
  const request = settingsOperationRequest(name, validatedInput);
  if (request.method !== 'POST') return null;
  const match = PROMOTION_PATH.exec(request.path);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

function settingsErrorFromCloud(error: unknown): Error {
  // The upgrade service's identity fence.
  if (error instanceof Error && error.message === 'account-changed')
    return new SettingsOperationError({ code: 'expired' });
  if (!(error instanceof CanopyCloudClientError))
    return error instanceof Error ? error : new Error('Promotion failed');
  if (error.code === 'network-error')
    return new SettingsOperationError({ code: 'uncertain' });
  if (error.code === 'missing-api-key')
    return new SettingsOperationError({ code: 'unauthenticated' });
  if (error.status === undefined)
    return new SettingsOperationError({ code: 'failed' });
  return new SettingsOperationError({
    code: settingsErrorCodeForStatus(error.status, { write: true }),
    status: error.status,
    ...(error.serverCode === undefined ? {} : { serverCode: error.serverCode }),
  });
}

/**
 * Resolver for the settings service. `getService` is lazy so the upgrade
 * service loads only when a promotion is actually requested.
 */
export function createSettingsOrchestratedOperations(
  getService: () => Promise<PersonalOrganizationUpgradeService> = async () =>
    (
      await import('./personal-organization-upgrade-host')
    ).getPersonalOrganizationUpgradeService(),
): SettingsOrchestrationResolver {
  return (name, validatedInput): SettingsOrchestratedOperation | null => {
    const organizationId = promotionOrganizationId(name, validatedInput);
    if (organizationId === null) return null;
    const body = UpgradePersonalOrganizationRequestSchema.safeParse(
      settingsOperationRequest(name, validatedInput).body,
    );
    if (!body.success || body.data.organizationId !== organizationId)
      return null;
    return async (): Promise<unknown> => {
      try {
        const outcome = await (await getService()).promote(body.data);
        return outcome.promotion;
      } catch (error) {
        throw settingsErrorFromCloud(error);
      }
    };
  };
}

/** Membership writes refresh main's account and finish context processing. */
export function createSettingsWriteFollowUps(
  refresh: SettingsWriteFollowUp = async (): Promise<void> => {
    const { reprobeAndApplyCanopyCloudEnforcedSettings } =
      await import('../ipc/settings');
    await reprobeAndApplyCanopyCloudEnforcedSettings();
    const { getWorkspaceContextService } =
      await import('../lib/workspace-context-service');
    await getWorkspaceContextService().whenIdle();
  },
): SettingsWriteFollowUpResolver {
  return (name, validatedInput): SettingsWriteFollowUp | null => {
    switch (name) {
      case 'account.settings.ai-gateway.update':
      case 'organization.settings.policies.update':
      case 'organization.create':
      case 'organization.delete':
      case 'organization.leave':
        return refresh;
      case 'organization.invitations.respond': {
        const input =
          ORGANIZATION_SETTINGS_OPERATIONS[name].input.safeParse(
            validatedInput,
          );
        return input.success && input.data.action === 'accept' ? refresh : null;
      }
      default:
        return null;
    }
  };
}
