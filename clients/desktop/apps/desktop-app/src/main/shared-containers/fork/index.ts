import {
  isSharedContainerForkProvenance,
  type SharedContainerForkProvenance,
  type SharedContainerForkRequest,
  type SharedContainerForkResponse,
} from '@canopy/protocol/shared-containers';
import { getSharedContainerReader } from '../read/reader';
import { forkSharedCodeContainer } from './code';
import { forkSharedCoworkContainer } from './cowork';
import { withSharedContainerForkGuard } from './fork-guard';
import { installForkCapabilityPackage } from '../capability-package/install';
import { z } from 'zod';
import { validateId } from '../../lib/validation';
import {
  SharedContainerForkError,
  validateForkDestination,
  resolveForkSourceContext,
  assertNewForkOwner,
  assertForkWorkspaceOwner,
} from './destination';
import {
  runW5BoundaryOperation,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from '../../lib/w5-boundary-operation';
import { W5RevisionConflictError } from '../../lib/w5-commit-log-file-store';
import {
  admitW5Composition,
  checkW5CompositionRevisions,
  decodeW5CompositionOutcome,
} from '../../lib/w5-composition-operation';

const forkOutcomeSchema = z.object({
  containerType: z.enum(['CODE_WORKTREE', 'COWORK_WORK_ENTRY']),
  projectId: z.string(),
  worktreeId: z.string(),
  warnings: z.array(z.string()),
  provenance: z.custom<SharedContainerForkProvenance>(
    isSharedContainerForkProvenance,
  ),
});
export type SharedContainerForkCommand = SharedContainerForkRequest &
  W5BoundaryOptions;

/**
 * Fork, then install the capability package the recipient was shown. The
 * install runs only after `runW5BoundaryOperation` has committed the copy and
 * outside its composition and rollback: a package failure becomes a warning
 * and never changes or undoes the fork.
 */
export async function forkSharedContainer(
  request: SharedContainerForkCommand,
): Promise<SharedContainerForkResponse> {
  const response = await forkSharedContainerCopy(request);
  const packageWarnings = await installForkCapabilityPackage({
    request,
    response,
  });
  return packageWarnings.length > 0
    ? { ...response, warnings: [...response.warnings, ...packageWarnings] }
    : response;
}

async function forkSharedContainerCopy(
  request: SharedContainerForkCommand,
): Promise<SharedContainerForkResponse> {
  validateId(request.containerId, 'containerId');
  validateId(request.revisionId, 'revisionId');
  if (
    typeof request.sourceOwnerDisplayName !== 'string' ||
    !request.sourceOwnerDisplayName.trim() ||
    request.sourceOwnerDisplayName.length > 256
  ) {
    throw new Error('Invalid sourceOwnerDisplayName');
  }
  const destination = validateForkDestination(request.destination);
  const sourceContext = await resolveForkSourceContext(request);
  request = {
    ...request,
    destination,
    organizationId: sourceContext.organizationId,
  };
  if (destination.kind === 'new-workspace') {
    assertNewForkOwner(destination, sourceContext.owner);
  } else {
    await assertForkWorkspaceOwner(
      destination.workspaceId,
      sourceContext.owner,
    );
  }
  const { expectedRevision, idempotencyKey } = request;
  return runW5BoundaryOperation(
    {
      operation: 'core.sharedContainer.fork',
      caller: 'desktop-host:shared-container-fork',
      idempotencyKey,
      parameters: {
        containerId: request.containerId,
        revisionId: request.revisionId,
        organizationId: request.organizationId,
        sourceOwnerDisplayName: request.sourceOwnerDisplayName,
        owner: sourceContext.owner,
        acceptedAt: sourceContext.acceptedAt,
        destination:
          request.destination.kind === 'existing-workspace'
            ? {
                kind: request.destination.kind,
                workspaceId: request.destination.workspaceId,
              }
            : {
                kind: request.destination.kind,
                owner: request.destination.owner,
                parentDirectory: request.destination.parentDirectory,
              },
      },
      recheckAtOutcome: true,
      // Only a refusal before the attempt's first effect releases the
      // reservation. Organization refusals can follow promotion, but both
      // creation paths call `beforeEffects` (directly, or through the
      // workspace creation commit) before their first effect, so those are
      // kept for recovery instead.
      isPreEffectRefusal: (error) =>
        error instanceof W5RevisionConflictError ||
        error instanceof SharedContainerForkError,
    },
    (outcome) => decodeW5CompositionOutcome(forkOutcomeSchema, outcome),
    async (commit, attempt) => {
      commit.expectedRevisions = w5ExpectedRevision(
        { kind: 'workspaces' },
        expectedRevision,
      );
      await checkW5CompositionRevisions(commit);
      return admitW5Composition(attempt, () =>
        withSharedContainerForkGuard(
          request,
          async (revisionRoot, revision) => {
            const reader = getSharedContainerReader();
            const source = await reader.readForkLayout({
              containerId: request.containerId,
              revisionId: request.revisionId,
            });
            if (source.root !== revisionRoot) {
              throw new Error('Shared-container revision changed during fork');
            }
            // Layout validation can outlive a revocation or ownership change.
            // Authorize after that read, immediately before dispatching effects.
            const latestContext = await resolveForkSourceContext(request);
            if (
              latestContext.acceptedAt !== sourceContext.acceptedAt ||
              latestContext.access !== sourceContext.access
            ) {
              throw new SharedContainerForkError(
                'source-unavailable',
                'The share’s access changed. Open the share again before making a copy.',
              );
            }
            if (request.destination.kind === 'existing-workspace') {
              await assertForkWorkspaceOwner(
                request.destination.workspaceId,
                sourceContext.owner,
              );
            }
            const provenance = {
              sourceContainerId: request.containerId,
              sourceRevisionId: revision.revisionId,
              sourceRevisionCreatedAt: revision.revisionCreatedAt,
              sourceOwnerDisplayName: request.sourceOwnerDisplayName,
              ...(request.organizationId !== undefined
                ? { organizationId: request.organizationId }
                : {}),
              forkedAt: new Date().toISOString(),
            };
            const options = {
              request,
              owner: sourceContext.owner,
              organizationName: latestContext.organizationName,
              provenance,
              revisionRoot,
              layout: source.layout,
              store: reader.store,
              commit,
              attempt,
            };
            if (source.layout.containerType === 'CODE_WORKTREE') {
              return forkSharedCodeContainer({
                ...options,
                layout: source.layout,
              });
            }
            if (source.layout.schemaVersion === 2) {
              throw new Error(
                'Cowork shared-container layout cannot use schema v2',
              );
            }
            return forkSharedCoworkContainer({
              ...options,
              layout: source.layout,
            });
          },
        ),
      );
    },
  );
}
