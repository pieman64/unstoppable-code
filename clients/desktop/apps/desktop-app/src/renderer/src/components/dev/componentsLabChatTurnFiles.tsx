import { useState, type JSX, type ReactNode } from 'react';
import {
  Button,
  TurnFileChipView,
  TurnFilesSummaryView,
  turnChangedFileRowsFrom,
  type TurnFileChipViewProps,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

const REVEAL = {
  label: 'Show report.csv in the file manager',
  tooltip: 'Show in the file manager',
  actionLabel: 'Open in the file manager',
  onReveal: noop,
};

function Chip(props: Partial<TurnFileChipViewProps>): JSX.Element {
  return <TurnFileChipView filename="report.csv" onOpen={noop} {...props} />;
}

/** The framed list a chip sits in inside a turn. */
function Frame({
  children,
  width,
}: {
  readonly children: ReactNode;
  readonly width?: number;
}): JSX.Element {
  return (
    <div
      className="max-w-full overflow-hidden rounded-xl border bg-base p-1"
      style={width ? { width } : { width: '100%' }}
    >
      {children}
    </div>
  );
}

export function TurnFileChipSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Row states">
        <SpecimenGrid min={280}>
          <SpecimenCell label="Created, openable">
            <Frame>
              <Chip />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Updated">
            <Frame>
              <Chip filename="notes.md" change="updated" />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Creating: busy, not openable">
            <Frame>
              <Chip pending />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Updating: busy, not openable">
            <Frame>
              <Chip pending change="updated" />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Waiting for approval: not busy yet">
            <Frame>
              <Chip pending waiting />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Opening: the host’s status line">
            <Frame>
              <Chip opening status="Opening…" />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Error: the host says why it can’t open">
            <Frame>
              <Chip status="The file was moved or deleted." />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="With its folder shown beside the name">
            <Frame>
              <Chip location="exports/2026/q3" />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Reveal control after the name">
            <Frame>
              <Chip reveal={REVEAL} />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Pending hides the reveal control">
            <Frame>
              <Chip pending reveal={REVEAL} />
            </Frame>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Names that do not fit">
        <SpecimenGrid min={280}>
          <SpecimenCell label="Long name: the middle truncates, the extension stays">
            <Frame width={240}>
              <Chip filename="a-very-long-quarterly-report-final-v2-reviewed.csv" />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Long name with a folder and reveal">
            <Frame width={300}>
              <Chip
                filename="a-very-long-quarterly-report-final-v2-reviewed.csv"
                location="exports/2026/q3/finance"
                reveal={REVEAL}
              />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Emoji and non-Latin names stay whole">
            <Frame width={240}>
              <Chip filename="🌲 планирование 計画.md" />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Long error status wraps">
            <Frame width={240}>
              <Chip status="The file was moved or deleted after the turn finished, so there is nothing to open." />
            </Frame>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Summary presentation (one file in a header)">
        <SpecimenCell label="Created" wide>
          <div className="flex w-full items-center rounded-xl border bg-base p-3">
            <Chip presentation="summary" />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Creating" wide>
          <div className="flex w-full items-center rounded-xl border bg-base p-3">
            <Chip presentation="summary" pending />
          </div>
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}

function FilesSummary({
  initiallyExpanded = false,
  heading,
  detail,
  actions,
  singleFile,
  changedFiles,
  children,
}: {
  readonly initiallyExpanded?: boolean;
  readonly heading: string;
  readonly detail?: ReactNode;
  readonly actions?: ReactNode;
  readonly singleFile?: ReactNode;
  readonly changedFiles?: readonly ReactNode[];
  readonly children?: ReactNode;
}): JSX.Element {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  return (
    <div className="w-full">
      <TurnFilesSummaryView
        heading={heading}
        expanded={expanded}
        onToggle={(): void => setExpanded((value) => !value)}
        detail={detail}
        actions={actions}
        singleFile={singleFile}
        changedFiles={changedFiles && turnChangedFileRowsFrom(changedFiles)}
      >
        {children}
      </TurnFilesSummaryView>
    </div>
  );
}

const CHANGED = [
  'src/app.ts',
  'src/routes.ts',
  'README.md',
  'package.json',
].map((name) => <Chip key={name} filename={name} change="updated" />);

const OUTPUTS = [
  <Chip key="report" filename="report.csv" />,
  <Chip key="chart" filename="chart.png" />,
];

export function TurnFilesSummarySpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="Files a turn changed or saved">
      <SpecimenCell label="Folded: click the heading to open" wide>
        <FilesSummary
          heading="4 files changed"
          detail={<span className="text-xs fg-tertiary">+82 −14</span>}
          changedFiles={CHANGED}
        />
      </SpecimenCell>
      <SpecimenCell
        label="Open: changed files, then saved files under a hairline"
        wide
      >
        <FilesSummary
          initiallyExpanded
          heading="4 files changed, 2 saved"
          changedFiles={CHANGED}
        >
          {OUTPUTS}
        </FilesSummary>
      </SpecimenCell>
      <SpecimenCell label="Open with actions after the heading" wide>
        <FilesSummary
          initiallyExpanded
          heading="4 files changed"
          detail={<span className="text-xs fg-tertiary">+82 −14</span>}
          actions={
            <>
              <Button variant="ghost" size="compact">
                Review
              </Button>
              <Button variant="secondary" size="compact">
                Open diff
              </Button>
            </>
          }
          changedFiles={CHANGED}
        />
      </SpecimenCell>
      <SpecimenCell label="One changed file takes the header’s slot" wide>
        <FilesSummary
          heading="1 file changed"
          singleFile={
            <Chip
              filename="src/app.ts"
              change="updated"
              presentation="summary"
            />
          }
        />
      </SpecimenCell>
      <SpecimenCell label="One saved file, inline" wide>
        <FilesSummary heading="1 file saved">
          <Chip filename="report.csv" />
        </FilesSummary>
      </SpecimenCell>
      <SpecimenCell
        label="Files still being written, one waiting for approval"
        wide
      >
        <FilesSummary
          initiallyExpanded
          heading="3 files changing"
          changedFiles={[
            <Chip key="a" filename="src/app.ts" change="updated" pending />,
            <Chip key="b" filename="src/new.ts" pending />,
            <Chip key="c" filename="src/held.ts" pending waiting />,
          ]}
        />
      </SpecimenCell>
      <SpecimenCell label="Open with nothing to list" wide>
        <FilesSummary initiallyExpanded heading="No files changed" />
      </SpecimenCell>
      <SpecimenCell label="Long heading truncates" wide>
        <FilesSummary
          heading={`${'12 files changed across the billing, invoicing and ledger packages, '.repeat(3)}`}
          changedFiles={CHANGED}
        />
      </SpecimenCell>
    </SpecimenPanel>
  );
}
