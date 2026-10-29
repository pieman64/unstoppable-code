/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DesktopCreateTeamDialogProps } from '../../../sidebar/DesktopCreateTeamDialog';
import { DesktopSettingsPromotionDialog } from '../DesktopSettingsPromotionDialog';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const refresh = jest.fn();
jest.mock('@canopy/ui-app/settings/host', () => ({
  useSettingsRouter: (): { refresh: () => void } => ({ refresh }),
}));

const dialogProps: DesktopCreateTeamDialogProps[] = [];
jest.mock('../../../sidebar/DesktopCreateTeamDialog', () => ({
  DesktopCreateTeamDialog: (
    props: DesktopCreateTeamDialogProps,
  ): JSX.Element => {
    dialogProps.push(props);
    return <div data-testid="create-team-dialog" />;
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  refresh.mockClear();
  dialogProps.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DesktopSettingsPromotionDialog', () => {
  it('opens the shared Create a team flow for the account and Personal organization', () => {
    const onClose = jest.fn();
    act(() => {
      root.render(
        <DesktopSettingsPromotionDialog
          accountKey="acct-1"
          personalOrganizationId="org-personal"
          inviteRequired
          onClose={onClose}
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="create-team-dialog"]'),
    ).not.toBeNull();
    const props = dialogProps.at(-1);
    expect(props).toMatchObject({
      accountId: 'acct-1',
      personalOrganizationId: 'org-personal',
      inviteRequired: true,
      onClose,
    });
    expect(refresh).not.toHaveBeenCalled();
    act(() => props?.onPromoted?.());
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
