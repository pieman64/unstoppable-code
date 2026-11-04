import type { JSX } from 'react';
import { Button, Disclosure } from '@canopy/ui-shared/components';
import { GrokLogo } from '@/components/GrokLogo';
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
  return (
    // The shared quiet expander, with the Grok mark after its chevron: its
    // label stays on the row's text column instead of reading as a second
    // trailing action.
    <Disclosure
      label="Only have a Grok account?"
      dataTestId="grok-unify"
      leadingIcon={
        <GrokLogo
          data-testid="grok-unify-logo"
          width={12}
          height={12}
          className="shrink-0"
          aria-hidden
        />
      }
    >
      <SettingsSubRow
        label="Grok is now merged with Cursor"
        description="To use your Grok plan here, unify your accounts, then sign in with Cursor. Once they're unified, your plan shows next to your Cursor sign-in."
        control={
          <Button
            size="compact"
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
    </Disclosure>
  );
}
