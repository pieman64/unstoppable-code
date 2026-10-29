import {
  isSharedAutomationDocument,
  type SharedAutomationDetail,
} from '@canopy/protocol/automations';

/**
 * E2E-only seam (dead code in production builds via `__CANOPY_E2E__`): the
 * offline UI-automation harness has no cloud account, so it injects a
 * fixture share directly and drives the real install wizard, mappers, IPC,
 * and persistence from there. Payload: `{ id, contentHash, document }`.
 */
export const AUTOMATIONS_E2E_INSTALL_FIXTURE_EVENT =
  'canopy:automations-e2e-install-fixture';

function readStringField(value: object, key: string): string | null {
  const entry: unknown = Reflect.get(value, key);
  return typeof entry === 'string' ? entry : null;
}

/**
 * The team share an install-fixture event describes, or `null` when the
 * payload is not `{ id, contentHash, document }` with a valid portable
 * document.
 */
export function parseAutomationsE2eInstallFixture(
  payload: unknown,
): SharedAutomationDetail | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const id = readStringField(payload, 'id');
  const contentHash = readStringField(payload, 'contentHash');
  const documentValue: unknown = Reflect.get(payload, 'document');
  if (
    id === null ||
    contentHash === null ||
    !isSharedAutomationDocument(documentValue)
  ) {
    return null;
  }
  return {
    id,
    name: documentValue.name,
    description: documentValue.description ?? '',
    triggerKind: documentValue.trigger.kind,
    actionType: documentValue.action.type,
    contentHash,
    shareScope: 'team',
    owner: {
      type: 'team',
      id: 'e2e-team',
      name: 'E2E Team',
      organization: { id: 'e2e-org', name: 'E2E Organization' },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: { id: 'e2e-user', name: 'E2E', email: null },
    canUpdate: false,
    canDelete: false,
    automation: documentValue,
  };
}
