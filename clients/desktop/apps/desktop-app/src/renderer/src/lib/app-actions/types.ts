/**
 * Renderer entry point for the App Advisor action contract. The canonical
 * union, payload shapes, and error enums live in `@canopy/desktop-shared`
 * so the renderer dispatcher and the main-process tool runtime agree on
 * the wire. This module re-exports those shared types and layers in
 * renderer-internal helpers (handler signatures, narrowing predicates,
 * exhaustiveness checks).
 *
 * Add new action variants in shared types; the {@link assertNever}
 * exhaustiveness check below makes the renderer dispatcher refuse to
 * compile until a handler is added.
 */
import type {
  AppAdvisorAction,
  AppAdvisorActionError,
  AppAdvisorActionErrorCode,
  AppAdvisorActionRequest,
  AppAdvisorActionResponse,
  AppAdvisorJson,
  AppAdvisorUiStateEnvelope,
} from '@canopy/desktop-shared/types';

export type {
  AppAdvisorAction,
  AppAdvisorActionError,
  AppAdvisorActionErrorCode,
  AppAdvisorActionRequest,
  AppAdvisorActionResponse,
  AppAdvisorJson,
  AppAdvisorUiStateEnvelope,
};

/**
 * Narrow an {@link AppAdvisorAction} to a specific variant by its `type`
 * tag. Used by the dispatcher's handler table for type-safe payload access.
 */
export type AppAdvisorActionOfType<T extends AppAdvisorAction['type']> =
  Extract<AppAdvisorAction, { type: T }>;

/**
 * Per-variant handler signature. Returns a partial response: the dispatcher
 * fills in `requestId` and the latest `uiState`; handlers focus on the
 * action-specific outcome.
 */
export type AppAdvisorActionHandlerResult = {
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
};

export type AppAdvisorActionHandler<T extends AppAdvisorAction['type']> = (
  action: AppAdvisorActionOfType<T>,
  request: AppAdvisorActionRequest,
) => Promise<AppAdvisorActionHandlerResult> | AppAdvisorActionHandlerResult;

/**
 * Compile-time exhaustiveness check. The dispatcher's `switch (action.type)`
 * routes to `assertNever(action)` in its `default` branch; if a new action
 * variant is added to the shared union without a handler, TypeScript narrows
 * `action` here to a non-`never` shape and the build fails.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled App Advisor action: ${JSON.stringify(value)}`);
}
