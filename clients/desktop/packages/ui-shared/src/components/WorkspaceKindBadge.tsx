import type { JSX } from 'react';
import { CoworkWorkspaceIcon } from '../icons/CoworkWorkspaceIcon';
import { MultiRepoIcon } from '../icons/MultiRepoIcon';
import { SingleRepoWorkspaceIcon } from '../icons/SingleRepoWorkspaceIcon';

export type WorkspaceKind = 'single-repo' | 'multi-repo' | 'cowork';

/**
 * The corner of the 16px workspace identity glyph: this badge, the avatar
 * that covers it, and the skeleton drawn in its place while a worktree is
 * created. It keeps the 24px `rounded-md` control's proportion (8/24) at
 * 16px, written as `--radius-md` less the 3px that proportion removes at
 * this size; it is the glyph's own shape, not a corner nested in the 10px
 * row (which would give 2px).
 */
export const WORKSPACE_GLYPH_RADIUS_CLASS =
  'rounded-[calc(var(--radius-md)-3px)]';

export interface WorkspaceKindBadgeProps {
  /** Which workspace kind glyph to render inside the badge. */
  kind: WorkspaceKind;
  /**
   * Marks the workspace as a transient adhoc container, rendering its glyph
   * inside a dashed neutral badge. Only meaningful for `kind: 'multi-repo'`.
   */
  temporary?: boolean;
  /** Hex color used for the badge background. Falls back to neutral gray. */
  color?: string;
  /**
   * Badge size. Both variants use the canonical 16px badge footprint; `'sm'`
   * reduces the glyph for dense chips such as kanban cards.
   */
  size?: 'sm' | 'md';
  /** Optional extra classes merged onto the badge wrapper. */
  className?: string;
  /** Appended to the fixed test id; see `WorkspaceSectionHeader.testIdSuffix`. */
  testIdSuffix?: string;
}

const WORKSPACE_CATEGORICAL_COLORS = {
  accent: 'var(--categorical-1)',
  green: 'var(--categorical-2)',
  orange: 'var(--categorical-3)',
  red: 'var(--categorical-4)',
  purple: 'var(--categorical-5)',
  blue: 'var(--categorical-6)',
} as const;

function hueFromHexColor(color: string): number | null {
  const match = color.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (!match) return null;

  const digits =
    match[1]?.length === 3
      ? [...match[1]].map((digit) => `${digit}${digit}`).join('')
      : match[1];
  if (!digits) return null;

  const red = Number.parseInt(digits.slice(0, 2), 16) / 255;
  const green = Number.parseInt(digits.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(digits.slice(4, 6), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  if (delta === 0) return null;

  const hueSegment =
    maximum === red
      ? ((green - blue) / delta) % 6
      : maximum === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  return (hueSegment * 60 + 360) % 360;
}

/**
 * Maps persisted workspace colors onto the generated, theme-aware categorical
 * palette. The stored value preserves the workspace's hue identity while the
 * rendered color follows the active UI Kit recipe.
 */
export function resolveWorkspaceBadgeBackgroundColor(
  color?: string,
  temporary = false,
): string {
  if (temporary) return 'transparent';

  const hue = color ? hueFromHexColor(color) : null;
  if (hue === null) return WORKSPACE_CATEGORICAL_COLORS.accent;
  if (hue < 15 || hue >= 345) return WORKSPACE_CATEGORICAL_COLORS.red;
  if (hue < 65) return WORKSPACE_CATEGORICAL_COLORS.orange;
  if (hue < 165) return WORKSPACE_CATEGORICAL_COLORS.green;
  if (hue < 185) return WORKSPACE_CATEGORICAL_COLORS.accent;
  if (hue < 255) return WORKSPACE_CATEGORICAL_COLORS.blue;
  return WORKSPACE_CATEGORICAL_COLORS.purple;
}

/**
 * Shared workspace identity. Single-repo and cowork projects use a compact
 * filled white folder inside their colored badge. Multi-repo projects retain
 * their solid or temporary badge.
 * The 16px slot keeps sidebar, picker, and kanban labels aligned.
 */
export function WorkspaceKindBadge({
  kind,
  temporary,
  color,
  size = 'md',
  className,
  testIdSuffix = '',
}: WorkspaceKindBadgeProps): JSX.Element {
  const isTemporary = kind === 'multi-repo' && temporary === true;
  const backgroundColor = resolveWorkspaceBadgeBackgroundColor(
    color,
    isTemporary,
  );

  const badgeSize = 'h-4 w-4';
  const temporaryIconSize = size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3';

  return (
    <span
      data-testid={`workspace-kind-badge${testIdSuffix}`}
      data-kind={kind}
      className={`inline-flex ${badgeSize} shrink-0 items-center justify-center self-center ${WORKSPACE_GLYPH_RADIUS_CLASS} align-middle${className ? ` ${className}` : ''}`}
      style={{
        backgroundColor,
        ...(isTemporary
          ? {
              borderColor: 'var(--fg-quaternary)',
              borderStyle: 'dashed',
              borderWidth: '1.25px',
            }
          : {}),
      }}
    >
      {/* Solid badges keep white artwork; temporary badges use the neutral foreground. */}
      <span
        className={`flex items-center justify-center ${isTemporary ? 'fg-primary' : 'text-white'}`}
        style={kind === 'multi-repo' ? undefined : { transform: 'scale(0.75)' }}
      >
        {kind === 'single-repo' && (
          <SingleRepoWorkspaceIcon className="h-3 w-3" />
        )}
        {kind === 'cowork' && <CoworkWorkspaceIcon className="h-3 w-3" />}
        {kind === 'multi-repo' &&
          (isTemporary ? (
            <MultiRepoIcon className={temporaryIconSize} />
          ) : (
            <MultiRepoIcon className="h-3 w-3" />
          ))}
      </span>
    </span>
  );
}
