import type { JSX } from 'react';
import {
  Heading,
  type HeadingTone,
  type HeadingVariant,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const VARIANTS: readonly HeadingVariant[] = [
  'display',
  'page',
  'section',
  'title',
  'label',
  'sidebar',
];

const TONES: readonly HeadingTone[] = [
  'destructive',
  'warning',
  'success',
  'muted',
];

/** Each heading role, and the status inks a heading can take. */
export function HeadingsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Variants">
        <SpecimenGrid min={280}>
          {VARIANTS.map((variant) => (
            <SpecimenCell key={variant} label={variant}>
              <Heading level={3} variant={variant}>
                Weekly digest
              </Heading>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Tones">
        <SpecimenGrid min={200}>
          {TONES.map((tone) => (
            <SpecimenCell key={tone} label={tone}>
              <Heading level={3} variant="title" tone={tone}>
                Delete this project
              </Heading>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Truncated">
        <SpecimenCell label="truncate" wide>
          <div className="w-48">
            <Heading level={3} variant="title" truncate>
              A very long heading that stops at the end of its line
            </Heading>
          </div>
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}
