import { useId, type JSX, type ReactNode } from 'react';
import { ToggleSwitch } from './ToggleSwitch';

export const DEFAULT_KEEP_LOCAL_BRANCH = true;

/** The shared branch choice for single and bulk worktree removal. */
export function KeepLocalBranchToggle({
  checked,
  onChange,
  children,
  dataTestId,
  noteTestId,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly children: ReactNode;
  readonly dataTestId: string;
  readonly noteTestId?: string;
}): JSX.Element {
  const noteId = useId();
  return (
    <div className="flex items-center gap-3 rounded-xl bg-subtle py-2 pl-3 pr-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-s fg-primary">Keep the local branch</div>
        <div
          id={noteId}
          className="text-pretty text-xs fg-tertiary wrap-anywhere"
          data-testid={noteTestId}
        >
          {children}
        </div>
      </div>
      <ToggleSwitch
        checked={checked}
        label="Keep the local branch"
        describedBy={noteId}
        onChange={onChange}
        dataTestId={dataTestId}
      />
    </div>
  );
}
