import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  CanopyDispatcherInstructionParamsInput,
  CanopyDispatcherInstructionResult,
} from '@canopy/core-runtime';
import {
  CATALOG_GRANTS,
  type CanopyErrorKind,
} from '@canopy/protocol/canopy-core';
import type { PortalCommandEnvelope } from '@canopy/protocol/portal';
import { captureCatalogPortalResult } from '../../canopy-runtime/catalog-portal-results';
import type { DesktopInstructionDefinitions } from '../../canopy-runtime/desktop-instruction-definitions';
import { getDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import { preserveRuntimeCauseError } from '../../canopy-runtime/runtime-cause-error';
import { createPortalCaller } from '../portal-caller';
import { getCanopyPortalState } from '../portal-session-manager';

type PortalCatalogInstruction =
  | 'core.catalog.source.upsert'
  | 'core.catalog.source.delete'
  | 'core.catalog.source.refresh'
  | 'core.catalog.plugin.install';

const PORTAL_CODES: Partial<Record<CanopyErrorKind, string>> = {
  invalid_argument: 'invalid_payload',
  not_found: 'not_found',
  conflict: 'conflict',
  already_exists: 'conflict',
  permission_denied: 'permission_denied',
};

function portalSessionId(): string {
  const sessionId = getCanopyPortalState().sessionId;
  if (!sessionId) throw new Error('Portal session is not active.');
  return sessionId;
}

/** A Portal command failure with today's code. */
export function portalError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The idempotency key a Portal command's catalog instruction carries. */
export function portalCommandKey(
  command: PortalCommandEnvelope<unknown>,
): string {
  return `portal:${command.id}`;
}

/**
 * Dispatches a catalog instruction for a Portal command, keyed by {@link portalCommandKey}, and returns the effect's Portal result when it ran.
 * `refusals` gives today's Portal error for a core refusal code that carries no host error.
 */
export async function dispatchPortalCatalogInstruction<
  Name extends PortalCatalogInstruction,
>(
  name: Name,
  params: CanopyDispatcherInstructionParamsInput<
    DesktopInstructionDefinitions,
    Name
  >,
  refusals: Readonly<Partial<Record<string, () => Error>>> = {},
): Promise<{
  result: CanopyDispatcherInstructionResult<
    DesktopInstructionDefinitions,
    Name
  >;
  portal: unknown;
}> {
  const sessionId = portalSessionId();
  const key = params._meta.idempotencyKey;
  try {
    return await captureCatalogPortalResult(() =>
      preserveRuntimeCauseError(
        getDesktopCanopyRuntime().instruction(name, params, {
          caller: createPortalCaller({ sessionId }, [CATALOG_GRANTS.write]),
          metadata: { idempotencyKey: key },
        }),
      ),
    );
  } catch (error) {
    if (error instanceof CanopyOperationError) {
      const legacy =
        error.payload.code === undefined
          ? undefined
          : refusals[error.payload.code];
      if (legacy) throw legacy();
      throw Object.assign(new Error(error.payload.message), {
        code: PORTAL_CODES[error.payload.kind] ?? 'execution_failed',
      });
    }
    throw error;
  }
}
