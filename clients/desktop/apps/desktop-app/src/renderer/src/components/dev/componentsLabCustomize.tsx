import type { JSX } from 'react';
import {
  Button,
  CustomizeBreadcrumbs,
  CustomizeInstalledUnavailable,
  CustomizeRowMenu,
  type CustomizeBreadcrumbItem,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

const LONG_NAME =
  'A custom skill with a name long enough that it cannot fit the page header';

const TRAIL: readonly CustomizeBreadcrumbItem[] = [
  { key: 'customize', label: 'Customize', onSelect: noop },
  { key: 'installed', label: 'Installed', onSelect: noop },
  { key: 'skill', label: 'Review changes' },
];

/**
 * The Customize page parts that are not rows: the location trail, the
 * capability-gated Installed state and a row's secondary-action menu.
 * Hover and press are real pointer states here, not forced ones; point at a
 * crumb or open a menu to see them.
 */
export function CustomizePartsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="CustomizeBreadcrumbs">
        <SpecimenCell label="Navigable trail ending at the current page" wide>
          <CustomizeBreadcrumbs items={TRAIL} />
        </SpecimenCell>
        <SpecimenCell label="Only the current page" wide>
          <CustomizeBreadcrumbs
            items={[{ key: 'customize', label: 'Customize' }]}
          />
        </SpecimenCell>
        <SpecimenCell
          label="A crumb with no destination reads as plain text"
          wide
        >
          <CustomizeBreadcrumbs
            items={[
              { key: 'customize', label: 'Customize', onSelect: noop },
              { key: 'shared', label: 'Shared by me' },
              { key: 'skill', label: 'Review changes' },
            ]}
          />
        </SpecimenCell>
        <SpecimenCell
          label="Web: href crumbs go through the host's router link"
          wide
        >
          <CustomizeBreadcrumbs
            items={[
              { key: 'customize', label: 'Customize', href: '/customize' },
              {
                key: 'installed',
                label: 'Installed',
                href: '/customize/installed',
              },
              { key: 'skill', label: 'Review changes' },
            ]}
            renderLink={({ href, className, children }) => (
              <a
                href={href}
                className={className}
                onClick={(event) => event.preventDefault()}
              >
                {children}
              </a>
            )}
          />
        </SpecimenCell>
        <SpecimenCell
          label="Long user-authored label: shrinks, truncates, masked in replay"
          wide
        >
          <div className="w-80 max-w-full">
            <CustomizeBreadcrumbs
              items={[
                { key: 'customize', label: 'Customize', onSelect: noop },
                {
                  key: 'skill',
                  label: LONG_NAME,
                  title: LONG_NAME,
                  privateLabel: true,
                  shrink: true,
                },
              ]}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long shrinking crumb that is still navigable" wide>
          <div className="w-80 max-w-full">
            <CustomizeBreadcrumbs
              items={[
                {
                  key: 'collection',
                  label: LONG_NAME,
                  title: LONG_NAME,
                  shrink: true,
                  onSelect: noop,
                },
                { key: 'skill', label: 'Review changes' },
              ]}
            />
          </div>
        </SpecimenCell>
      </SpecimenPanel>

      <SpecimenPanel title="CustomizeInstalledUnavailable">
        <SpecimenCell label="With the host's pairing control" wide>
          <div className="w-full">
            <CustomizeInstalledUnavailable
              title="Installed items are on your desktop"
              body="Pair this browser with Acme on your computer to see what is installed there."
              action={<Button variant="primary">Pair a computer</Button>}
              dataTestId="lab-installed-unavailable-action"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell
          label="No action: neither pairing nor sign-in applies"
          wide
        >
          <div className="w-full">
            <CustomizeInstalledUnavailable
              title="Installed items can't be read here yet"
              body="This host does not read the installed inventory."
              dataTestId="lab-installed-unavailable-plain"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long copy wraps; the action drops below" wide>
          <div className="w-full max-w-md">
            <CustomizeInstalledUnavailable
              title="Installed items are on your desktop and need a paired computer to load"
              body="Pair this browser with Acme on your computer, keep that computer awake and online, and reload this page to see the skills, plugins and apps installed there."
              action={<Button>Pair a computer</Button>}
              dataTestId="lab-installed-unavailable-long"
            />
          </div>
        </SpecimenCell>
      </SpecimenPanel>

      <SpecimenPanel title="CustomizeRowMenu (click the ⋯ to open)">
        <SpecimenGrid min={200}>
          <SpecimenCell label="Actions, then a destructive item after a divider">
            <CustomizeRowMenu
              entryName="Review changes"
              idPrefix="lab-menu-default"
              testId="lab-row-menu-default"
              items={[
                { id: 'edit', label: 'Edit', onSelect: noop },
                { id: 'share', label: 'Share', onSelect: noop },
                {
                  id: 'remove',
                  label: 'Delete',
                  onSelect: noop,
                  destructive: true,
                },
              ]}
            />
          </SpecimenCell>
          <SpecimenCell label="A disabled item explains why">
            <CustomizeRowMenu
              entryName="Review changes"
              idPrefix="lab-menu-disabled"
              testId="lab-row-menu-disabled"
              items={[
                {
                  id: 'edit',
                  label: 'Edit',
                  onSelect: noop,
                  disabled: true,
                  disabledReason: 'Edit this skill in the desktop app.',
                },
                { id: 'share', label: 'Share', onSelect: noop },
              ]}
            />
          </SpecimenCell>
          <SpecimenCell label="Destructive only: no divider">
            <CustomizeRowMenu
              entryName="Review changes"
              idPrefix="lab-menu-destructive"
              testId="lab-row-menu-destructive"
              items={[
                {
                  id: 'remove',
                  label: 'Uninstall',
                  onSelect: noop,
                  destructive: true,
                },
              ]}
            />
          </SpecimenCell>
          <SpecimenCell label="Long item label">
            <CustomizeRowMenu
              entryName={LONG_NAME}
              idPrefix="lab-menu-long"
              testId="lab-row-menu-long"
              items={[
                {
                  id: 'edit',
                  label: 'Open the original in the source repository',
                  onSelect: noop,
                },
              ]}
            />
          </SpecimenCell>
          <SpecimenCell label="No actions: renders nothing">
            <CustomizeRowMenu
              entryName="Review changes"
              idPrefix="lab-menu-empty"
              testId="lab-row-menu-empty"
              items={[]}
            />
            <span className="text-2xs fg-tertiary">(nothing renders)</span>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
