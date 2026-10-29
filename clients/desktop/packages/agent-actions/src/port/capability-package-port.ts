import type {
  CapabilityPackageAnalyzeInput,
  CapabilityPackageAnalysisResult,
} from '@canopy/protocol/capability-package-repair';
import type { AgentActionCall } from '../surface/family';
import type { AgentJson } from '../response';

export type AgentCapabilityPackageAnalysisResult =
  CapabilityPackageAnalysisResult & { agentArtifacts?: AgentJson[] };

export interface AgentCapabilityPackagePort<H> {
  analyze(
    input: CapabilityPackageAnalyzeInput,
    call: AgentActionCall<H>,
  ): Promise<AgentCapabilityPackageAnalysisResult>;
}
