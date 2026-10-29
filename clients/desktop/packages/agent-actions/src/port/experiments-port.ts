import type { LabsExperimentChoiceRequest } from '@canopy/protocol/experiments';
import type { AgentActionCall } from '../surface/family';

export interface AgentExperimentWriteResult {
  experimentId: string;
  storedChoice: boolean;
  effectiveEnabledAtCommit: boolean;
  listedAtCommit: boolean;
  generationAtCommit: number;
  revisionAtCommit: number;
}
export interface AgentExperimentsPort<H> {
  setEnabled(
    request: LabsExperimentChoiceRequest,
    call: AgentActionCall<H>,
  ): Promise<AgentExperimentWriteResult>;
}
