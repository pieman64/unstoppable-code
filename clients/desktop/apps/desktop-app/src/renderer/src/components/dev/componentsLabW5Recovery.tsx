import type { JSX } from 'react';
import {
  projectRemoteW5Recovery,
  W5RecoveryReasonSchema,
  type W5RecoveryReason,
  type W5RecoveryStatus,
} from '@canopy/protocol/portal';
import {
  W5RecoveryNotice,
  type W5RecoveryNoticeProps,
} from '@canopy/ui-shared/components';
import { SpecimenCell, SpecimenPanel } from './componentsLabParts';

const noop = (): void => undefined;

const blocked: W5RecoveryStatus = {
  state: 'blocked',
  canRecover: true,
  entries: [
    {
      id: 'interrupted-change',
      operation: 'core.workspace.update',
      detail: 'Interrupted workspace record update',
    },
  ],
};

const fiveEntries = Array.from({ length: 5 }, (_, index) => ({
  id: `interrupted-change-${index}`,
  operation: 'core.workspace.update',
  detail: `Interrupted workspace record update ${index + 1}`,
}));

const diagnosisReasons: readonly W5RecoveryReason[] = [
  'log-unavailable',
  'source-unavailable',
  'launch-recovery-pending',
  'operation-excluded',
  'history-unproven',
  'recovery-required',
  'cancelled',
];

const cases: readonly {
  readonly label: string;
  readonly props: W5RecoveryNoticeProps;
}[] = [
  {
    label: 'Hidden: no notice',
    props: { status: { state: 'hidden', canRecover: false, entries: [] } },
  },
  {
    label: 'Blocked: recovery available on this host',
    props: { status: blocked, canRecover: true, onRecover: noop },
  },
  {
    label: 'Preparing recovery: busy action',
    props: { status: blocked, canRecover: true, onRecover: noop, busy: true },
  },
  {
    label: 'Blocked: no diagnostic entries',
    props: {
      status: { ...blocked, entries: [] },
      canRecover: true,
      onRecover: noop,
    },
  },
  {
    label: 'Exactly five entries: no overflow summary',
    props: {
      status: { ...blocked, entries: fiveEntries },
      canRecover: true,
      onRecover: noop,
    },
  },
  {
    label:
      'Six entries: first five shown, long detail truncated to 160 characters',
    props: {
      status: {
        ...blocked,
        entries: [
          ...fiveEntries.map((entry) => ({
            ...entry,
            detail: 'Long diagnostic detail. '.repeat(12),
          })),
          {
            id: 'overflow-change',
            operation: 'core.workspace.update',
            detail: 'This sixth entry is included only in the diagnosis.',
          },
        ],
      },
      canRecover: true,
      onRecover: noop,
    },
  },
  {
    label: 'Host capability omitted: default-deny',
    props: { status: blocked, onRecover: noop },
  },
  {
    label: 'Maximum diagnosis: 200 entries with unbroken operation and detail',
    props: {
      status: {
        ...blocked,
        entries: Array.from({ length: 200 }, (_, index) => ({
          id: `maximum-change-${index}`,
          operation: 'x'.repeat(256),
          detail: 'y'.repeat(2000),
        })),
      },
      canRecover: true,
      onRecover: noop,
    },
  },
  {
    label: 'Portal: read-only diagnosis, recover on this computer guidance',
    props: {
      status: projectRemoteW5Recovery(blocked),
      canRecover: false,
      onRecover: noop,
    },
  },
  {
    label: 'Portal refusal: read-only diagnosis with support guidance',
    props: {
      status: projectRemoteW5Recovery({
        ...blocked,
        state: 'refused',
        canRecover: false,
        reason: 'source-unavailable',
      }),
      canRecover: false,
      onRecover: noop,
    },
  },
  {
    label: 'Target cannot recover: diagnose only, despite host capability',
    props: {
      status: { ...blocked, canRecover: false },
      canRecover: true,
      onRecover: noop,
    },
  },
  {
    label: 'Recovery handler unavailable: no action',
    props: { status: blocked, canRecover: true },
  },
  {
    label:
      'Restart required: diagnosis retained, writes paused, no Portal guidance',
    props: {
      status: { ...blocked, state: 'restart-required', canRecover: false },
    },
  },
  {
    label: 'Complete: positive outcome, no Portal guidance',
    props: { status: { state: 'complete', canRecover: false, entries: [] } },
  },
  {
    label: 'Refused without a reason: default guidance',
    props: {
      status: { state: 'refused', canRecover: false, entries: [] },
      canRecover: true,
    },
  },
];

export function W5RecoverySpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="W5RecoveryNotice: lifecycle, capabilities and entries">
        {cases.map(({ label, props }) => (
          <SpecimenCell key={label} label={label} wide>
            <div className="w-full">
              <W5RecoveryNotice {...props} />
            </div>
          </SpecimenCell>
        ))}
      </SpecimenPanel>
      <SpecimenPanel title="Read-only diagnosis: blocked changes with retained entries">
        {diagnosisReasons.map((reason) => (
          <SpecimenCell key={reason} label={reason} wide>
            <div className="w-full">
              <W5RecoveryNotice
                status={{ ...blocked, canRecover: false, reason }}
                canRecover
                onRecover={noop}
              />
            </div>
          </SpecimenCell>
        ))}
      </SpecimenPanel>
      <SpecimenPanel title="Refusals: every protocol reason with retained entries">
        {W5RecoveryReasonSchema.options.map((reason) => (
          <SpecimenCell key={reason} label={reason} wide>
            <div className="w-full">
              <W5RecoveryNotice
                status={{
                  state: 'refused',
                  canRecover: false,
                  reason,
                  entries: blocked.entries,
                }}
                canRecover
              />
            </div>
          </SpecimenCell>
        ))}
      </SpecimenPanel>
    </div>
  );
}
