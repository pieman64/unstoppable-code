/**
 * Re-export of the shared-pipeline local-id contract, which lives in
 * `@canopy/protocol` so `apps/web` can use it too.
 *
 * The id is a wire shape, not a desktop concern: the portal inventory document
 * carries it, and web surfaces that must exclude shared rows need a check that
 * does not depend on the `origin` field surviving an older or rolled-back
 * projector. `apps/web` may not import `@canopy/desktop-shared`, so the
 * canonical module moved to protocol (CAN-3021) and this path stays as the
 * desktop-side compatibility entry point.
 */

export {
  buildSharedPipelineId,
  isAddressableSharedPipelineRemoteId,
  parseSharedPipelineLocalId,
  isSharedPipelineLocalId,
  type ParsedSharedPipelineLocalId,
} from '@canopy/protocol/pipelines';
