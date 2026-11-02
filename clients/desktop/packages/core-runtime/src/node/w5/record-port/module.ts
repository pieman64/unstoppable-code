import {
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import {
  defineRuntimeModule,
  type RuntimeModule,
} from '../../../kernel/runtime-profile-graph';
import {
  createW5RecordAuthority,
  type W5RecordAuthorityOptions,
} from './authority';

/** The names a host binds to its interface lease (`leaseBoundOperations`). */
export const W5_RECORD_PORT_OPERATIONS: readonly string[] = [
  ...Object.keys(CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS),
  ...Object.keys(CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS),
];

/** The grants a W5 qualification host gives its trusted peers. */
export const W5_RECORD_PORT_GRANTS = [
  'core.workspaceRecords.read',
  'core.workspaceRecords.write',
] as const;

/**
 * `core.workspaceRecords.*` over the daemon's W5 host (W6g, CAN-5498;
 * receipts and reservations, CAN-5506).
 * Composed only by the W5 qualification host; the web core never registers it.
 */
export function createW5RecordPortModule(
  options: W5RecordAuthorityOptions,
): RuntimeModule {
  const authority = createW5RecordAuthority(options);
  return defineRuntimeModule({
    name: 'core.workspaceRecords',
    plane: 'core',
    definitions: {
      queries: CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
      instructions: CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: {
        'core.workspaceRecords.capture': (params) => authority.capture(params),
        'core.workspaceRecords.recovery.get': () => authority.recovery(),
        'core.workspaceRecords.receipt.lookup': ({ receipt }) =>
          authority.lookupReceipt(receipt),
        'core.workspaceRecords.reservation.list': () =>
          authority.listReservations(),
      },
      instructions: {
        'core.workspaceRecords.commit': (params, { caller }) =>
          authority.commit(caller, params),
        'core.workspaceRecords.reservation.reserve': async (params) => {
          await authority.reserve(params);
          return {};
        },
        'core.workspaceRecords.reservation.updateDiagnostics': async ({
          reservationId,
          diagnostics,
        }) => {
          await authority.updateReservationDiagnostics(
            reservationId,
            diagnostics,
          );
          return {};
        },
        'core.workspaceRecords.reservation.release': async ({
          reservationId,
        }) => {
          await authority.releaseReservation(reservationId);
          return {};
        },
        'core.workspaceRecords.reservation.markRecoveryRequired': async ({
          reservationId,
          diagnostics,
        }) => {
          await authority.markReservationRecoveryRequired(
            reservationId,
            diagnostics,
          );
          return {};
        },
      },
      streams: {},
    },
  });
}
