import { useState, type JSX } from 'react';
import {
  InstructionsEditor,
  ReadyStatusLine,
  ReferenceHoverCard,
  ReferenceHoverCardFact,
} from '@canopy/ui-shared/components';
import { CircleCheckIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

const SAMPLE_INSTRUCTIONS =
  'Answer in short sentences.\nLink the pull request when you mention one.';

function EditableInstructions(): JSX.Element {
  const [value, setValue] = useState(SAMPLE_INSTRUCTIONS);
  return (
    <InstructionsEditor
      value={value}
      onChange={setValue}
      label="Project instructions"
      showHeading
      description="Every chat in this project starts with these."
      notices={<p className="text-xs fg-secondary">Saves to AGENTS.md.</p>}
    />
  );
}

/** Reference hover cards, ready lines and the instructions editor. */
export function ReferenceAndInstructionsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="ReferenceHoverCard">
        <SpecimenGrid min={280}>
          <SpecimenCell label="Status, context, title, person and counts">
            <ReferenceHoverCard
              icon={CircleCheckIcon}
              ink="fg-success"
              lead="Merged"
              context={['#812', 'canopy']}
              trailing="2h ago"
              title="Share the loading skeleton across pickers"
              person="Sample person"
              facts={[
                <ReferenceHoverCardFact key="files">
                  12 files
                </ReferenceHoverCardFact>,
                <ReferenceHoverCardFact key="comments">
                  3 comments
                </ReferenceHoverCardFact>,
              ]}
              replayBlock={false}
            />
          </SpecimenCell>
          <SpecimenCell label="Title and detail, no footer">
            <ReferenceHoverCard
              icon={null}
              lead="Skill"
              trailing="Plugin"
              title="Release notes"
              detail="Drafts release notes from merged pull requests."
              replayBlock={false}
            />
          </SpecimenCell>
          <SpecimenCell label="Note under the title">
            <ReferenceHoverCard
              icon={CircleCheckIcon}
              lead="Open"
              title="Keep the composer steady while a reply streams"
              note={<span className="fg-tertiary">Checked 2m ago</span>}
              replayBlock={false}
            />
          </SpecimenCell>
          <SpecimenCell label="Long title wraps; lead keeps its own ink">
            <ReferenceHoverCard
              icon={CircleCheckIcon}
              ink="fg-success"
              leadInk="fg-primary"
              lead="In review"
              context={['#4021']}
              title="Move every hand-drawn loading state in the workspace sidebar to the measured skeleton without changing any row height"
              person="Sample person"
              replayBlock={false}
            />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="ReadyStatusLine">
        <SpecimenGrid min={240}>
          <SpecimenCell label="One short sentence">
            <ReadyStatusLine>Ready to use</ReadyStatusLine>
          </SpecimenCell>
          <SpecimenCell label="Long sentence wraps beside the check">
            <ReadyStatusLine>
              Your account is connected, so every chat in this project can use
              it right away
            </ReadyStatusLine>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="InstructionsEditor">
        <SpecimenGrid min={320}>
          <SpecimenCell label="Heading, description and a host notice" wide>
            <div className="flex h-56 w-full flex-col">
              <EditableInstructions />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Empty, with a placeholder">
            <div className="flex h-32 w-full flex-col">
              <InstructionsEditor
                value=""
                onChange={noop}
                label="Project instructions"
                placeholder="Tell every chat how to work here"
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Disabled, in the mono face">
            <div className="flex h-32 w-full flex-col">
              <InstructionsEditor
                value={SAMPLE_INSTRUCTIONS}
                onChange={noop}
                label="Project instructions"
                disabled
                mono
              />
            </div>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
