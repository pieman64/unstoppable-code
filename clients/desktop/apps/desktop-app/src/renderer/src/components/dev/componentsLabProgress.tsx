import type { JSX } from 'react';
import {
  ProgressBar,
  ProgressRing,
  ProgressSteps,
  type ProgressStep,
  type ProgressTone,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const TONES: readonly ProgressTone[] = [
  'accent',
  'warning',
  'destructive',
  'neutral',
];

const RUN: readonly (readonly ProgressStep[])[] = [
  [{ id: 'plan', state: 'done' }],
  [
    { id: 'build', state: 'done' },
    { id: 'test', state: 'running' },
  ],
  [{ id: 'review', state: 'queued' }],
  [{ id: 'ship', state: 'queued' }],
];

const FAILED_RUN: readonly (readonly ProgressStep[])[] = [
  [{ id: 'plan', state: 'done' }],
  [
    { id: 'build', state: 'failed' },
    { id: 'test', state: 'cancelled' },
  ],
  [{ id: 'ship', state: 'paused' }],
];

export function ProgressSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="ProgressBar: 6px, the label at the left and its value at the right">
        <div className="flex w-full max-w-xl flex-col gap-4">
          <ProgressBar value={42} label="Importing 4 of 10 projects" />
          <ProgressBar
            value={86}
            tone="warning"
            label="Credits used this month"
          />
          <ProgressBar value={100} tone="destructive" label="Context window" />
          <ProgressBar
            value={30}
            label="Resuming sessions"
            valueText="3 of 10 handled"
          />
          <ProgressBar value={0} indeterminate label="Installing Ollama" />
        </div>
      </SpecimenPanel>
      <SpecimenPanel title="Tones, sizes and a bar without its label row">
        <SpecimenGrid min={200}>
          {TONES.map((tone) => (
            <SpecimenCell key={tone} label={`tone ${tone}`}>
              <ProgressBar value={60} tone={tone} label={tone} hideLabel />
            </SpecimenCell>
          ))}
          <SpecimenCell label="size compact (4px), in a dense row">
            <ProgressBar
              value={60}
              size="compact"
              label="Weekly limit"
              hideLabel
            />
          </SpecimenCell>
          <SpecimenCell label="indeterminate, label hidden">
            <ProgressBar value={0} indeterminate label="Upload" hideLabel />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="ProgressRing: 16px with a 2px stroke, inside a small control">
        <SpecimenGrid min={120}>
          {TONES.map((tone) => (
            <SpecimenCell key={tone} label={`tone ${tone}`}>
              <ProgressRing value={tone === 'neutral' ? 30 : 70} tone={tone} />
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="ProgressSteps: 12px status glyphs, stages split by a short rule">
        <SpecimenGrid min={200}>
          <SpecimenCell label="running">
            <ProgressSteps stages={RUN} label="Run steps" />
          </SpecimenCell>
          <SpecimenCell label="failed, cancelled and paused steps">
            <ProgressSteps stages={FAILED_RUN} />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
