import {
  AgentPortError,
  type AgentExperimentsPort,
  type AgentExperimentWriteResult,
} from '@canopy/agent-actions';
import type { LabsExperimentChoiceRequest } from '@canopy/protocol/experiments';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { getLabsExperimentsService } from '../services/labs-experiments-runtime';
import { LabsExperimentError } from '../services/labs-experiments-service';
import {
  CanopyCloudClientError,
  isTransientCanopyCloudFailure,
} from '../canopy-cloud/client';

export const desktopExperimentsPort: AgentExperimentsPort<CanopyInjectedToolRuntime> =
  {
    setEnabled: async (
      request: LabsExperimentChoiceRequest,
    ): Promise<AgentExperimentWriteResult> => {
      try {
        const snapshot = await getLabsExperimentsService().setChoice(request);
        const entry = snapshot.experiments.find(
          (entry) => entry.id === request.experimentId,
        );
        if (!entry || entry.choice === null)
          throw new AgentPortError(
            'execution_failed',
            'Experiment choice was not committed.',
          );
        return {
          experimentId: entry.id,
          storedChoice: entry.choice,
          effectiveEnabledAtCommit: entry.enabled,
          listedAtCommit: entry.listed,
          generationAtCommit: snapshot.generation,
          revisionAtCommit: snapshot.revision,
        };
      } catch (error) {
        if (error instanceof LabsExperimentError)
          throw new AgentPortError(
            error.code,
            error.message,
            error.code === 'surface_unavailable',
          );
        if (error instanceof CanopyCloudClientError)
          throw new AgentPortError(
            isTransientCanopyCloudFailure(error)
              ? 'surface_unavailable'
              : 'execution_failed',
            error.message,
            isTransientCanopyCloudFailure(error),
          );
        if (error instanceof AgentPortError) throw error;
        throw new AgentPortError(
          'execution_failed',
          error instanceof Error
            ? error.message
            : 'Could not persist experiment choice.',
        );
      }
    },
  };
