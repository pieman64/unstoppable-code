import type { JSX } from 'react';
import { describeAgentBaseModel } from '@canopy/protocol/agents';
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
    <div className="space-y-6" data-testid="agent-definition-summary">
      {baseModel !== undefined && (
        <dl className="rounded-xl border bg-card p-4 text-sm sm:p-5">
          <dt className="text-xs font-medium fg-secondary">Base model</dt>
          <dd className="mt-1 break-words">
            {describeAgentBaseModel(baseModel)}
          </dd>
        </dl>
      )}

      <section>
        <Heading level={2} variant="title">
          Instructions
        </Heading>
        <pre className="mt-2 whitespace-pre-wrap break-words rounded-xl border bg-card p-4 font-sans text-sm">
          {instructions || 'No additional instructions.'}
        </pre>
      </section>

      <section>
        <Heading level={2} variant="title">
          {pluginsLabel}
        </Heading>
        {plugins.length === 0 ? (
          <p className="mt-2 text-sm fg-secondary">{pluginsEmptyLabel}</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {plugins.map((plugin) => (
              <li
                key={plugin.key}
                className="rounded-lg border bg-card px-4 py-3 text-sm"
              >
                {plugin.label}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
