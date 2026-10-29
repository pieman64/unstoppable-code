import type {
  SharedContainerForkRequest,
  SharedContainerForkResponse,
} from '@canopy/protocol/shared-containers';
import { getSharedContainerReader } from '../read/reader';
import { forkSharedCodeContainer } from './code';
import { forkSharedCoworkContainer } from './cowork';
import { withSharedContainerForkGuard } from './fork-guard';
import { z } from 'zod';
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
  provenance: z.object({
    sourceContainerId: z.string(),
    sourceRevisionId: z.string(),
    sourceOwnerDisplayName: z.string(),
    organizationId: z.string().optional(),
    forkedAt: z.string(),
  }),
});
export type SharedContainerForkCommand = SharedContainerForkRequest &
  W5BoundaryOptions;

export function forkSharedContainer(
  request: SharedContainerForkCommand,
): Promise<SharedContainerForkResponse> {
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
        destination:
          request.destination.kind === 'existing-workspace'
            ? {
                kind: request.destination.kind,
                workspaceId: request.destination.workspaceId,
              }
            : {
                kind: request.destination.kind,
                parentDirectory: request.destination.parentDirectory,
              },
      },
      recheckAtOutcome: true,
      isPreEffectRefusal: (error) => error instanceof W5RevisionConflictError,
    },
    (outcome) => decodeW5CompositionOutcome(forkOutcomeSchema, outcome),
    async (commit, attempt) => {
      commit.expectedRevisions = w5ExpectedRevision(
        { kind: 'workspaces' },
        expectedRevision,
      );
      await checkW5CompositionRevisions(commit);
      return admitW5Composition(attempt, () =>
        withSharedContainerForkGuard(request, async (revisionRoot) => {
          const reader = getSharedContainerReader();
          const source = await reader.readForkLayout({
            containerId: request.containerId,
            revisionId: request.revisionId,
          });
          if (source.root !== revisionRoot) {
            throw new Error('Shared-container revision changed during fork');
          }
          const provenance = {
            sourceContainerId: request.containerId,
            sourceRevisionId: request.revisionId,
            sourceOwnerDisplayName: request.sourceOwnerDisplayName,
            ...(request.organizationId !== undefined
              ? { organizationId: request.organizationId }
              : {}),
            forkedAt: new Date().toISOString(),
          };
          const options = {
            request,
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
        }),
      );
    },
  );
}
