import { useId, useState, type JSX } from 'react';
import { Button } from '@canopy/ui-shared/components';
import { ChevronRightIcon } from '@canopy/ui-shared/icons/AppIcons';
import { GrokLogo } from '@/components/GrokLogo';
import { useSettingsButtonSize } from '@/hooks/useSettingsButtonSize';
import { SettingsSubRow } from './SettingsLayout';

/** Where a Grok subscriber starts unifying their Grok and Cursor accounts. */
const CURSOR_UNIFY_ACCOUNTS_URL = 'https://cursor.com/unify';

/**
 * Grok has no sign-in of its own here. Its plans now cover Cursor, but
 * Cursor's sign-in takes a Cursor account only, so a Grok subscriber unifies
 * the two accounts and then signs in with Cursor. Only a Grok-only account
 * needs that, and a standing unify button read as a step every Cursor
 * account still owed, so the hint sits collapsed under Cursor's row. It has
 * no status dot: there is no Grok connection to report.
 */
export function GrokUnifyHint(): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  return (
    <div data-testid="grok-unify" className="flex flex-col gap-2">
      {/* The quiet inline expander of the shared `AdvancedDisclosure`, not a
          ghost `Button`: its padding would pull the label off the row's text
          column and read as a second trailing action. */}
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        data-testid="grok-unify-toggle"
        onClick={(): void => setExpanded((open) => !open)}
        className="focus-ring flex w-fit items-center gap-1.5 rounded-md text-xs font-medium fg-secondary transition-colors hover:fg-primary"
      >
        <GrokLogo
          data-testid="grok-unify-logo"
          width={12}
          height={12}
          className="shrink-0"
          aria-hidden
        />
        Only have a Grok account?
        <ChevronRightIcon
          size={12}
          aria-hidden
          className={`shrink-0 transition-transform duration-150 ${
            expanded ? 'rotate-90' : ''
          }`}
        />
      </button>
      {expanded && (
        <div id={bodyId}>
          <SettingsSubRow
            dataTestId="grok-unify-body"
            label="Grok is now merged with Cursor"
            description="To use your Grok plan here, unify your accounts, then sign in with Cursor. Once they're unified, your plan shows next to your Cursor sign-in."
            control={
              <Button
                size={settingsButtonSize}
                data-testid="grok-unify-accounts"
                onClick={(): void => {
                  void window.api.browser.openExternal({
                    url: CURSOR_UNIFY_ACCOUNTS_URL,
                  });
                }}
              >
                Unify accounts
              </Button>
            }
          />
        </div>
      )}
    </div>
  );
}
