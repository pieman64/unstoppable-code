import { useState, type JSX, type ReactNode } from 'react';
import { Select, TextArea, TextInput } from '@canopy/ui-shared/components';

/**
 * The shared `TextInput`, `TextArea`, and `Select` (question forms lab,
 * "Fields" view) in every state, on both surfaces a field lands on: inside
 * the raised tertiary question card and on an ordinary base page. Tab
 * through them, or click one, to see the real neutral focus state.
 */

const ENVIRONMENTS = [
  { value: 'staging', label: 'Staging' },
  { value: 'production', label: 'Production' },
  { value: 'preview', label: 'Preview (unavailable)', disabled: true },
] as const;

function LabSelect(): JSX.Element {
  const [value, setValue] = useState<string | null>(null);
  return (
    <Select
      aria-label="Environment"
      options={ENVIRONMENTS}
      value={value}
      onValueChange={setValue}
    />
  );
}

function FieldSet(): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <TextInput aria-label="Placeholder" placeholder="e.g. Atlas" />
      <TextInput aria-label="Filled" defaultValue="Atlas" />
      <TextInput aria-label="Disabled" defaultValue="Disabled" disabled />
      <TextArea
        aria-label="Long answer"
        placeholder="The idea, the audience, and what success looks like…"
      />
      <LabSelect />
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

export function FieldOptionsLab(): JSX.Element {
  return (
    <div
      className="flex flex-col gap-6 p-6 text-pretty"
      data-testid="field-options-lab"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-m fg-primary">Fields</h1>
        <p className="text-s fg-tertiary">
          The shared TextInput, TextArea, and Select. Tab through them, or click
          one, to see the neutral focus state.
        </p>
      </header>
      <div className="flex flex-col gap-3 md:flex-row">
        <Surface
          label="In the question card"
          className="rounded-2xl bg-tertiary p-3 shadow-lg"
        >
          <FieldSet />
        </Surface>
        <Surface label="On a page" className="rounded-2xl bg-base p-3">
          <FieldSet />
        </Surface>
      </div>
    </div>
  );
}
