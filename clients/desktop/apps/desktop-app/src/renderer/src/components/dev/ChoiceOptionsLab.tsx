import { useState, type JSX, type ReactNode } from 'react';
import {
  Checkbox,
  ChoiceField,
  ChoiceMark,
  Radio,
} from '@canopy/ui-shared/components';

/**
 * The shared `Checkbox`, `Radio`, and `ChoiceMark` (question forms lab,
 * "Choices" view) in every state, standalone and as option rows, on both
 * surfaces a choice lands on: inside the raised tertiary question card and on
 * an ordinary base page.
 */

function States(): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <span className="w-18 text-s fg-tertiary">Checkbox</span>
        <Checkbox aria-label="Checkbox off" checked={false} readOnly />
        <Checkbox aria-label="Checkbox on" checked readOnly />
        <Checkbox
          aria-label="Checkbox off, disabled"
          checked={false}
          disabled
          readOnly
        />
        <Checkbox
          aria-label="Checkbox on, disabled"
          checked
          disabled
          readOnly
        />
      </div>
      <div className="flex items-center gap-4">
        <span className="w-18 text-s fg-tertiary">Radio</span>
        <Radio aria-label="Radio off" checked={false} readOnly />
        <Radio aria-label="Radio on" checked readOnly />
        <Radio
          aria-label="Radio off, disabled"
          checked={false}
          disabled
          readOnly
        />
        <Radio aria-label="Radio on, disabled" checked disabled readOnly />
      </div>
      <div className="flex items-center gap-4">
        <span className="w-18 text-s fg-tertiary">Mark</span>
        <ChoiceMark kind="checkbox" checked={false} />
        <ChoiceMark kind="checkbox" checked />
        <ChoiceMark kind="radio" checked={false} />
        <ChoiceMark kind="radio" checked />
      </div>
    </div>
  );
}

const ROW_LABELS = ['Search', 'Analytics', 'Team spaces'] as const;
const ROW_CLASS =
  'flex min-h-9 cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 text-s fg-primary hover:bg-subtle has-[:focus-visible]:bg-subtle';

function Rows({ multi }: { multi: boolean }): JSX.Element {
  const [picked, setPicked] = useState<readonly string[]>(['Analytics']);
  const toggle = (label: string): void =>
    setPicked((current) =>
      multi
        ? current.includes(label)
          ? current.filter((entry) => entry !== label)
          : [...current, label]
        : [label],
    );
  return (
    <div className="-mx-2 flex flex-col gap-0.5">
      {ROW_LABELS.map((label) => (
        <div key={label} className={ROW_CLASS}>
          <ChoiceField
            kind={multi ? 'checkbox' : 'radio'}
            label={label}
            name={multi ? undefined : 'lab-radio-rows'}
            checked={picked.includes(label)}
            onChange={() => toggle(label)}
          />
        </div>
      ))}
    </div>
  );
}

function Surface({
  label,
  className,
  children,
}: {
  label: string;
  className: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="px-1 text-xs fg-tertiary">{label}</span>
      <div className={className}>{children}</div>
    </div>
  );
}

function Contents(): JSX.Element {
  return (
    <>
      <States />
      <Rows multi />
      <Rows multi={false} />
    </>
  );
}

export function ChoiceOptionsLab(): JSX.Element {
  return (
    <div
      className="flex flex-col gap-6 p-6 text-pretty"
      data-testid="choice-options-lab"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-m fg-primary">Checkbox and radio</h1>
        <p className="text-s fg-tertiary">
          The shared Checkbox, Radio, and ChoiceMark. Click the rows to toggle
          them, or Tab to see the focus halo.
        </p>
      </header>
      <div className="flex flex-col gap-3 md:flex-row">
        <Surface
          label="In the question card"
          className="flex flex-col gap-3 rounded-2xl bg-tertiary p-3 shadow-lg"
        >
          <Contents />
        </Surface>
        <Surface
          label="On a page"
          className="flex flex-col gap-3 rounded-2xl bg-base p-3"
        >
          <Contents />
        </Surface>
      </div>
    </div>
  );
}
