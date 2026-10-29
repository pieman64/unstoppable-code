import { type JSX, useId, useRef, useState } from 'react';
import { FloatingMenu } from '@canopy/ui-shared';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
} from '@canopy/ui-shared/components';
import { ChevronDownIcon } from '@canopy/ui-shared/icons';
import { Hammer2Icon } from '@canopy/ui-shared/icons/AppIcons';

export interface CreatePipelineSplitButtonProps {
  /** Main action: start the AI interview in a new Cowork chat (CAN-3487). */
  onStartInterview: () => void;
  /** Chevron menu action: open the manual pipeline builder. */
  onBuildManually: () => void;
  /** Disables the split action while the interview chat is being created. */
  interviewPending?: boolean;
  /**
   * Prefix for the three stable test ids: `<prefix>` (main action),
   * `<prefix>-menu` (chevron) and `<prefix>-manual` (Build manually row).
   */
  testIdPrefix: string;
}

/**
 * The Pipelines tab's "New pipeline" split action. The main button
 * starts an AI interview in a normal Cowork chat; the chevron keeps the
 * manual builder one step away behind "Build manually".
 */
export function CreatePipelineSplitButton({
  onStartInterview,
  onBuildManually,
  interviewPending = false,
  testIdPrefix,
}: CreatePipelineSplitButtonProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const clusterRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  return (
    <div
      ref={clusterRef}
      className="inline-flex items-stretch rounded-lg bg-accent fg-emphasis"
      data-testid={`${testIdPrefix}-split`}
    >
      <button
        type="button"
        onClick={() => {
          setMenuOpen(false);
          onStartInterview();
        }}
        disabled={interviewPending}
        aria-busy={interviewPending}
        data-testid={testIdPrefix}
        className="rounded-l-lg px-4 py-2 text-s font-medium transition-opacity hover:opacity-90 focus-ring disabled:cursor-default disabled:opacity-70"
      >
        New pipeline
      </button>
      <span aria-hidden="true" className="my-2 w-px bg-current opacity-30" />
      <button
        ref={chevronRef}
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-label="More ways to create a pipeline"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        disabled={interviewPending}
        data-testid={`${testIdPrefix}-menu`}
        className="flex items-center rounded-r-lg px-2 transition-opacity hover:opacity-90 focus-ring disabled:cursor-default disabled:opacity-70"
      >
        <ChevronDownIcon width={16} height={16} aria-hidden="true" />
      </button>
      <FloatingMenu
        id={menuId}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        anchorRef={clusterRef}
        returnFocusRef={chevronRef}
        outsidePressBoundaryRef={clusterRef}
        placement="bottom-right"
        role="menu"
        aria-label="Create pipeline options"
        data-testid={`${testIdPrefix}-options`}
        className="w-48"
      >
        <ActionMenuRowStyle>
          <ActionMenuItems
            items={[
              {
                key: 'manual',
                label: 'Build manually',
                icon: <Hammer2Icon />,
                testId: `${testIdPrefix}-manual`,
              },
            ]}
            onSelect={(): void => {
              setMenuOpen(false);
              chevronRef.current?.focus({ preventScroll: true });
              onBuildManually();
            }}
          />
        </ActionMenuRowStyle>
      </FloatingMenu>
    </div>
  );
}
