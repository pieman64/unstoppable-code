import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  APP_ADVISOR_ACTION_GRANTS,
  type AppAdvisorActionGrant,
} from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';

/** D7: the advisor chat's own principal; grants are exactly APP_ADVISOR_ACTION_GRANTS. */
export function appAdvisorActionCaller(chatId: string): CanopyCallerDescriptor {
  return {
    principalId: 'desktop-app-advisor',
    clientInstanceId: `app-advisor-chat:${chatId}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'mcp',
    grants: [...APP_ADVISOR_ACTION_GRANTS],
  };
}

/** The grants of `required` the caller does not hold, in `required` order. */
export function missingAppAdvisorGrants(
  caller: CanopyCallerDescriptor,
  required: readonly AppAdvisorActionGrant[],
): AppAdvisorActionGrant[] {
  const held = new Set<string>(caller.grants);
  return required.filter((grant) => !held.has(grant));
}
