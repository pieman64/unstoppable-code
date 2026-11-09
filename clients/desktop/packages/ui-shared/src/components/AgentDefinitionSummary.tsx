import { Stack } from './Stack';
import type { JSX } from 'react';
import { describeAgentBaseModel } from '@canopy/protocol/agents';
import { Fact, FactList } from './FactList';
import { Heading } from './Heading';

export interface AgentDefinitionSummaryPlugin {
  key: string;
  label: string;
}

export interface AgentDefinitionSummaryProps {
  /** Omitted by portable documents that pin no model (workspace templates). */
  baseModel?: string;
  instructions: string;
  plugins: readonly AgentDefinitionSummaryPlugin[];
  /** Section heading over `plugins`. Defaults to `Plugins`. */
  pluginsLabel?: string;
  /** Empty-state copy for `plugins`. Defaults to `No plugins required.` */
  pluginsEmptyLabel?: string;
}

/**
 * Pure, portable definition display shared by public web and desktop. Used for
 * shared Agents and for workspace templates, which carry the same
 * instructions-plus-portable-capabilities shape without a pinned model.
 */
export function AgentDefinitionSummary({
  baseModel,
  instructions,
  plugins,
  pluginsLabel = 'Plugins',
  pluginsEmptyLabel = 'No plugins required.',
}: AgentDefinitionSummaryProps): JSX.Element {
  return (
    <Stack gap="section" data-testid="agent-definition-summary">
      {baseModel !== undefined && (
        <div className="rounded-xl border bg-card p-4 text-s sm:p-5">
          <FactList layout="stacked" size="inherit">
            <Fact
              label={
                <span className="text-xs font-medium fg-secondary">
                  Base model
                </span>
              }
            >
              {describeAgentBaseModel(baseModel)}
            </Fact>
          </FactList>
        </div>
      )}

      <Stack as="section" gap="inline">
        <Heading level={2} variant="title">
          Instructions
        </Heading>
        <pre className="whitespace-pre-wrap break-words rounded-xl border bg-card p-4 font-sans text-s">
          {instructions || 'No additional instructions.'}
        </pre>
      </Stack>

      <Stack as="section" gap="inline">
        <Heading level={2} variant="title">
          {pluginsLabel}
        </Heading>
        {plugins.length === 0 ? (
          <p className="text-s fg-secondary">{pluginsEmptyLabel}</p>
        ) : (
          <Stack as="ul" gap="inline">
            {plugins.map((plugin) => (
              <li
                key={plugin.key}
                className="rounded-lg border bg-card px-4 py-3 text-s"
              >
                {plugin.label}
              </li>
            ))}
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}
