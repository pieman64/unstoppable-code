import type { JSX, SVGProps } from 'react';
import {
  getProviderForModel,
  resolveAgentModelDefinition,
  resolveKnownModel,
  type ChatModel,
} from '@canopy/desktop-shared/types';
import type {
  UiAgentProvider,
  UiTrackedPlanSource,
} from '@/lib/providerLabels';
import { ModelProviderIcon } from '@canopy/ui-shared';
import {
  ClaudeLogo,
  CodexLogo,
  OllamaLogo,
  PipelineIcon,
} from '@canopy/ui-shared/icons';
import {
  FileDownIcon as AppCatalogFileDownIcon,
  DocumentSearchIcon as AppCatalogDocumentSearchIcon,
} from '@canopy/ui-shared/icons/AppIcons';

type ChatProviderFields = {
  providerType?: UiAgentProvider;
  model?: ChatModel;
};

export function resolveChatTabProvider(
  tab: ChatProviderFields,
  defaultWorktreeModel: ChatModel | undefined,
): UiAgentProvider | undefined {
  if (tab.providerType !== undefined) {
    return tab.providerType;
  }
  const model = tab.model ?? defaultWorktreeModel;
  if (model === undefined) {
    return undefined;
  }
  const knownModel = resolveKnownModel(model);
  if (knownModel === undefined) {
    return undefined;
  }
  const agent = resolveAgentModelDefinition(knownModel);
  if (agent && !agent.available) {
    return undefined;
  }
  return getProviderForModel(knownModel);
}

export function AgentProviderIcon({
  provider,
  central = false,
  ...svgProps
}: {
  provider: UiAgentProvider;
  central?: boolean;
} & SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <ModelProviderIcon provider={provider} central={central} {...svgProps} />
  );
}

export function PlanSourceIcon({
  source,
  ...svgProps
}: { source: UiTrackedPlanSource } & SVGProps<SVGSVGElement>): JSX.Element {
  switch (source) {
    case 'opencode':
      return <ModelProviderIcon provider="opencode" {...svgProps} />;
    case 'copilot':
      return <ModelProviderIcon provider="copilot" {...svgProps} />;
    case 'cursor':
      return <ModelProviderIcon provider="cursor" {...svgProps} />;
    case 'claude':
      return <ClaudeLogo {...svgProps} />;
    case 'codex':
      return <CodexLogo {...svgProps} />;
    case 'ollama':
      return <OllamaLogo {...svgProps} />;
    case 'pipeline':
      return <PipelineIcon {...svgProps} />;
    case 'imported':
      return <AppCatalogFileDownIcon {...svgProps} />;
    case 'detected':
      return <AppCatalogDocumentSearchIcon {...svgProps} />;
  }
}
