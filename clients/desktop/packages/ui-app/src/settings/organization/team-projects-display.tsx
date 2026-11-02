'use client';

import type { JSX } from 'react';
import { GitIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useSettingsPrivacy } from '../host';

/**
 * Display pieces shared by the organization admin Projects tab and its
 * Repositories dialog (CAN-3466).
 */

/**
 * The Projects and Repositories search rule (CAN-3466): a case-insensitive
 * substring of a project name or a repository name. The `owner/` prefix never
 * matches, so typing `uns` does not match every `unstoppabledomains/*`
 * repository. Callers pass only names, never the owner or the full name.
 */
export function matchesProjectSearch(
  query: string,
  names: ReadonlyArray<string | null | undefined>,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return true;
  return names.some(
    (name): boolean =>
      typeof name === 'string' && name.toLocaleLowerCase().includes(needle),
  );
}

interface RepositoryLabelProps {
  owner: string;
  name: string;
  'data-testid'?: string;
}

/** `owner/name` in the code face with the git glyph, as one quiet line. */
export function RepositoryLabel({
  owner,
  name,
  'data-testid': testId,
}: RepositoryLabelProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  return (
    <span
      data-testid={testId}
      className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs fg-tertiary"
    >
      <GitIcon size={12} aria-hidden="true" className="shrink-0" />
      <span
        className={
          blockClassName === '' ? 'truncate' : `truncate ${blockClassName}`
        }
      >
        {owner}/{name}
      </span>
    </span>
  );
}
