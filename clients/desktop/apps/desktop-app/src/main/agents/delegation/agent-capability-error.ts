import type {
  DelegationCapabilityKind,
  DelegationCapabilitySkipReason,
} from '@canopy/protocol/delegation';
import { delegationCapabilityDisplayName } from '@canopy/desktop-shared/node/delegation/capability-grant';

export type DelegationAgentCapabilityErrorCode =
  | 'missing_selection'
  | 'unsupported_capability'
  | 'unsupported_hooks'
  | 'unsupported_lsp'
  | 'unavailable_asset'
  | 'unsupported_skill_execution'
  | 'config_changed'
  | 'invalid_projection';

const MESSAGES: Record<DelegationAgentCapabilityErrorCode, string> = {
  missing_selection:
    'A selected Agent capability is unavailable. Restore it or edit the Agent.',
  unsupported_capability:
    'This Agent selects a capability that managed delegation cannot run.',
  unsupported_hooks:
    'Remove plugin hooks or monitors, or select a different plugin for managed delegation.',
  unsupported_lsp:
    'Remove plugin language server configuration, or select a different plugin for managed delegation.',
  unavailable_asset:
    'Remove the unsupported file from the Agent capability, or select a different capability for managed delegation.',
  unsupported_skill_execution:
    'A selected skill or command runs code outside managed approvals. Remove its fork, agent, or shell preprocessing instruction before delegation.',
  config_changed:
    'A selected Agent capability changed. Start a new delegation with the current configuration.',
  invalid_projection: 'The selected Agent capability configuration is invalid.',
};

const ITEM_REASONS: Record<DelegationAgentCapabilityErrorCode, string> = {
  missing_selection: 'it is not installed or is turned off',
  unsupported_capability: "managed delegation can't run it",
  unsupported_hooks: 'it uses plugin hooks or monitors',
  unsupported_lsp: 'it configures a language server',
  unavailable_asset:
    "it has files managed delegation can't load, or it is too large",
  unsupported_skill_execution: 'it runs code outside managed approvals',
  config_changed: 'its configuration changed',
  invalid_projection: 'its configuration is invalid',
};

const KIND_LABELS: Record<DelegationCapabilityKind, string> = {
  skill: 'skill',
  plugin: 'plugin',
  mcp: 'MCP server',
};

const SKIP_REASONS: Record<
  DelegationAgentCapabilityErrorCode,
  DelegationCapabilitySkipReason
> = {
  missing_selection: 'missing_selection',
  unsupported_capability: 'unsupported_capability',
  unsupported_hooks: 'unsupported_hooks',
  unsupported_lsp: 'unsupported_lsp',
  unavailable_asset: 'unavailable_asset',
  unsupported_skill_execution: 'unsupported_skill_execution',
  config_changed: 'missing_selection',
  invalid_projection: 'unsupported_capability',
};

export function delegationCapabilitySkipReason(
  code: DelegationAgentCapabilityErrorCode,
): DelegationCapabilitySkipReason {
  return SKIP_REASONS[code];
}

/** Fixed public copy; never include raw paths, credentials, or warnings. */
export class DelegationAgentCapabilityError extends Error {
  readonly publicMessage: string;
  readonly item?: {
    readonly kind: DelegationCapabilityKind;
    readonly name: string;
  };

  constructor(
    readonly code: DelegationAgentCapabilityErrorCode,
    item?: {
      readonly kind: DelegationCapabilityKind;
      readonly name: string;
    },
  ) {
    const publicMessage = item
      ? 'The ' +
        KIND_LABELS[item.kind] +
        ' "' +
        delegationCapabilityDisplayName(item.name) +
        '" can\'t be given to this delegate: ' +
        ITEM_REASONS[code] +
        '.'
      : MESSAGES[code];
    super(publicMessage);
    this.name = 'DelegationAgentCapabilityError';
    this.publicMessage = publicMessage;
    if (item !== undefined) this.item = item;
  }
}

export function delegationAgentCapabilityError(
  value: unknown,
): DelegationAgentCapabilityError | undefined {
  return value instanceof DelegationAgentCapabilityError ? value : undefined;
}
