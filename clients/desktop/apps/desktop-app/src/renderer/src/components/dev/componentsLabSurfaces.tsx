import type { JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  Divider,
  Inline,
  Stack,
  Surface,
  type SurfacePadding,
  type SurfaceVariant,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const VARIANTS: readonly { variant: SurfaceVariant; use: string }[] = [
  { variant: 'outline', use: 'a hairline box, no fill' },
  { variant: 'group', use: 'grouped rows, Settings' },
  { variant: 'card', use: 'a standalone item' },
  { variant: 'raised', use: 'floats over a busy background' },
  { variant: 'inset', use: 'a well inside a group or card' },
];

const PADDINGS: readonly { padding: SurfacePadding; px: number }[] = [
  { padding: 'none', px: 0 },
  { padding: 'tight', px: 8 },
  { padding: 'compact', px: 12 },
  { padding: 'default', px: 16 },
  { padding: 'roomy', px: 24 },
];

function Sample({ title }: { readonly title: string }): JSX.Element {
  return (
    <Stack gap="tight">
      <span className="text-s font-medium fg-primary">{title}</span>
      <span className="text-xs fg-secondary">Updated 2 minutes ago</span>
    </Stack>
  );
}

function VariantGrid(): JSX.Element {
  return (
    <SpecimenGrid min={180}>
      {VARIANTS.map(({ variant, use }) => (
        <SpecimenCell key={variant} label={`${variant}: ${use}`}>
          <Surface variant={variant} padding="compact" className="w-full">
            <Sample title="Weekly digest" />
          </Surface>
        </SpecimenCell>
      ))}
    </SpecimenGrid>
  );
}

export function SurfacesSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Variants, on the secondary background">
        <VariantGrid />
      </SpecimenPanel>
      <SpecimenPanel title="Variants, on the page background">
        <Surface variant="inset" padding="default">
          <VariantGrid />
        </Surface>
      </SpecimenPanel>
      <SpecimenPanel title="Selected (a picked plan, project or template)">
        <SpecimenGrid min={180}>
          {VARIANTS.map(({ variant }) => (
            <SpecimenCell key={variant} label={`${variant}, selected`}>
              <Surface
                variant={variant}
                padding="compact"
                selected
                className="w-full"
              >
                <Sample title="Team plan" />
              </Surface>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Padding roles">
        <SpecimenGrid min={160}>
          {PADDINGS.map(({ padding, px }) => (
            <SpecimenCell key={padding} label={`${padding}, ${px}px`}>
              <Surface variant="card" padding={padding} className="w-full">
                <Sample title="Runs" />
              </Surface>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Empty and long content">
        <SpecimenGrid min={260}>
          <SpecimenCell label="card, padding=default, no children">
            <Surface variant="card" padding="default" className="w-full" />
          </SpecimenCell>
          <SpecimenCell label="outline, long text wraps inside the padding">
            <Surface variant="outline" padding="compact" className="w-full">
              <p className="text-s text-pretty wrap-anywhere fg-primary">
                packages/ui-shared/src/components/settings/hosted/organization-members-section-with-a-very-long-name.tsx
                failed to load because the workspace index is still being
                rebuilt after the last pull.
              </p>
            </Surface>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Column gap and nesting">
        <SpecimenGrid min={260}>
          <SpecimenCell label="card, padding=default, gap=item">
            <Surface
              variant="card"
              padding="default"
              gap="item"
              className="w-full"
            >
              <Sample title="Pull request" />
              <Surface variant="inset" padding="tight">
                <span
                  className={`${POSTHOG_REPLAY_BLOCK_CLASS} font-mono text-xs fg-secondary`}
                >
                  git push origin feat/surfaces
                </span>
              </Surface>
            </Surface>
          </SpecimenCell>
          <SpecimenCell label="group, rows split by a Divider">
            <Surface variant="group" className="w-full">
              <div className="px-4 py-3">
                <Sample title="Model" />
              </div>
              <Divider />
              <div className="px-4 py-3">
                <Sample title="Effort" />
              </div>
            </Surface>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Divider">
        <SpecimenGrid min={260}>
          <SpecimenCell label="horizontal (default)" wide>
            <Stack gap="item" className="w-full">
              <Sample title="Above" />
              <Divider />
              <Sample title="Below" />
            </Stack>
          </SpecimenCell>
          <SpecimenCell label="vertical, in a row">
            <Inline gap="item">
              <span className="text-s fg-primary">Branch</span>
              <Divider orientation="vertical" />
              <span className="text-s fg-primary">develop</span>
            </Inline>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
