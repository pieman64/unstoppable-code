import { memo, useId, useState, type JSX } from 'react';
import {
  DELEGATION_CAPABILITY_LIMITS,
  type DelegationCapabilitySummary,
} from '@canopy/protocol/delegation';
import {
  DELEGATED_AGENT_CAPABILITIES_HIDE_LABEL,
  DELEGATED_AGENT_CAPABILITIES_LABEL,
  DELEGATED_AGENT_CAPABILITIES_SHOW_LABEL,
  DELEGATED_AGENT_CAPABILITIES_SKIPPED_LABEL,
  DELEGATED_AGENT_CAPABILITY_SOURCE_ORDER,
  delegatedAgentCapabilityCountsLabel,
  delegatedAgentCapabilityKindLabel,
  delegatedAgentCapabilitySkipReasonLabel,
  delegatedAgentCapabilitySourceLabel,
  delegatedAgentOmittedLabel,
} from './delegated-agent-copy';

export interface DelegatedAgentCapabilitiesProps {
  summary: DelegationCapabilitySummary;
}

export const DelegatedAgentCapabilities = memo(
  function DelegatedAgentCapabilities({
    summary,
  }: DelegatedAgentCapabilitiesProps): JSX.Element {
    const [open, setOpen] = useState(false);
    const detailsId = useId();
    const items = summary.items.slice(
      0,
      DELEGATION_CAPABILITY_LIMITS.summaryItems,
    );
    const skipped = summary.skipped.slice(
      0,
      DELEGATION_CAPABILITY_LIMITS.summarySkipped,
    );
    const omittedItems = summary.omittedItems ?? 0;
    const omittedSkipped = summary.omittedSkipped ?? 0;
    const showSkipped = skipped.length > 0 || omittedSkipped > 0;

    return (
      <>
        <dt>{DELEGATED_AGENT_CAPABILITIES_LABEL}</dt>
        <dd data-testid="delegated-agent-capabilities" className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-x-2">
            <span className="min-w-0 break-words">
              {delegatedAgentCapabilityCountsLabel(summary)}
            </span>
            <button
              type="button"
              data-testid="delegated-agent-capabilities-toggle"
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={
                open
                  ? DELEGATED_AGENT_CAPABILITIES_HIDE_LABEL
                  : DELEGATED_AGENT_CAPABILITIES_SHOW_LABEL
              }
              className="shrink-0 fg-secondary underline hover:fg-primary focus-visible:outline focus-visible:ring-1 focus-visible:ring-line-accent"
              onClick={(): void => setOpen((current): boolean => !current)}
            >
              {open ? 'Hide' : 'Show'}
            </button>
          </div>
          {open ? (
            <div id={detailsId} className="mt-1 min-w-0 space-y-1.5">
              {DELEGATED_AGENT_CAPABILITY_SOURCE_ORDER.map(
                (source): JSX.Element | null => {
                  const sourceItems = items.filter(
                    (item): boolean => item.source === source,
                  );
                  if (sourceItems.length === 0) return null;
                  return (
                    <div
                      key={source}
                      data-testid={`delegated-agent-capability-${source}`}
                      className="min-w-0"
                    >
                      <p className="font-medium fg-primary">
                        {delegatedAgentCapabilitySourceLabel(source)}
                      </p>
                      <ul className="list-none space-y-0.5 p-0">
                        {sourceItems.map(
                          (item, index): JSX.Element => (
                            <li
                              key={`${index}-${item.name}`}
                              className="break-words"
                            >
                              <span>
                                {item.name.slice(
                                  0,
                                  DELEGATION_CAPABILITY_LIMITS.nameCharacters,
                                )}
                              </span>{' '}
                              <span className="fg-tertiary">
                                · {delegatedAgentCapabilityKindLabel(item.kind)}
                              </span>
                            </li>
                          ),
                        )}
                      </ul>
                    </div>
                  );
                },
              )}
              {omittedItems > 0 ? (
                <p className="break-words fg-tertiary">
                  {delegatedAgentOmittedLabel(omittedItems)}
                </p>
              ) : null}
              {showSkipped ? (
                <div
                  data-testid="delegated-agent-capability-skipped"
                  className="min-w-0"
                >
                  <p className="font-medium fg-primary">
                    {DELEGATED_AGENT_CAPABILITIES_SKIPPED_LABEL}
                  </p>
                  <ul className="list-none space-y-0.5 p-0">
                    {skipped.map(
                      (item, index): JSX.Element => (
                        <li
                          key={`${index}-${item.name}`}
                          className="break-words"
                        >
                          <span>
                            {item.name.slice(
                              0,
                              DELEGATION_CAPABILITY_LIMITS.nameCharacters,
                            )}
                          </span>{' '}
                          <span className="fg-tertiary">
                            · {delegatedAgentCapabilityKindLabel(item.kind)}
                          </span>
                          <span className="fg-tertiary">
                            {' · '}
                            {delegatedAgentCapabilitySkipReasonLabel(
                              item.reason,
                            )}
                          </span>
                        </li>
                      ),
                    )}
                    {omittedSkipped > 0 ? (
                      <li className="break-words fg-tertiary">
                        {delegatedAgentOmittedLabel(omittedSkipped)}
                      </li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </dd>
      </>
    );
  },
);
