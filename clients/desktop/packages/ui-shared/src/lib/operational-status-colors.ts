/**
 * Run-state colors shared by chats, pipelines, scripts, terminals, browsers,
 * pull requests, and worktree status indicators.
 *
 * Each state uses an intent role, whose hue is fixed in every theme: failed
 * is destructive, succeeded is success, merged is special, unread is info, and
 * paused is the secondary neutral. Inks, dots, borders, and rings take the
 * intent's `-strong` ink, which carries small text at 4.5:1 on light
 * surfaces; tints take the intent's `-subtle` surface. Running takes info
 * like unread: it draws a spinner and unread a dot, so shape tells them
 * apart. Never use the accent for a run state: it changes with the theme.
 */
export const OPERATIONAL_STATUS_COLORS = {
  unread: {
    foreground: 'fg-info',
    foregroundQuiet: 'fg-info/70',
    foregroundMuted: 'fg-info/80',
    background: 'bg-fg-info',
    backgroundQuiet: 'bg-info-subtle',
    backgroundSubtle: 'bg-info-subtle',
    backgroundMuted: 'bg-fg-info/25',
    border: 'border-fg-info',
    ring: 'ring-fg-info/20',
    ringQuiet: 'ring-fg-info/10',
    hoverBackground: 'hover:bg-info-subtle',
  },
  active: {
    foreground: 'fg-info',
    foregroundQuiet: 'fg-info/70',
    foregroundMuted: 'fg-info/80',
    background: 'bg-fg-info',
    backgroundQuiet: 'bg-info-subtle',
    backgroundSubtle: 'bg-info-subtle',
    backgroundBadge: 'bg-info-subtle',
    backgroundMuted: 'bg-fg-info/25',
    backgroundPing: 'bg-fg-info/60',
    border: 'border-fg-info',
    ring: 'ring-fg-info/20',
    ringQuiet: 'ring-fg-info/10',
    borderMuted: 'border-fg-info/60',
    hoverBackground: 'hover:bg-info-subtle',
  },
  failed: {
    foreground: 'fg-destructive-strong',
    foregroundQuiet: 'fg-destructive-strong/70',
    foregroundMuted: 'fg-destructive-strong/80',
    background: 'bg-fg-destructive-strong',
    backgroundQuiet: 'bg-destructive-subtle',
    backgroundSubtle: 'bg-destructive-subtle',
    backgroundBadge: 'bg-destructive-subtle',
    backgroundMuted: 'bg-fg-destructive-strong/25',
    border: 'border-fg-destructive-strong',
    ring: 'ring-fg-destructive-strong/20',
    ringQuiet: 'ring-fg-destructive-strong/10',
    borderSubtle: 'border-fg-destructive-strong/30',
    hoverBackground: 'hover:bg-destructive-subtle',
  },
  success: {
    foreground: 'fg-success-strong',
    foregroundQuiet: 'fg-success-strong/70',
    foregroundMuted: 'fg-success-strong/80',
    background: 'bg-fg-success-strong',
    backgroundQuiet: 'bg-success-subtle',
    backgroundSubtle: 'bg-success-subtle',
    backgroundBadge: 'bg-success-subtle',
    backgroundMuted: 'bg-fg-success-strong/25',
    backgroundPing: 'bg-fg-success-strong/60',
    border: 'border-fg-success-strong',
    ring: 'ring-fg-success-strong/20',
    ringQuiet: 'ring-fg-success-strong/10',
    borderSubtle: 'border-fg-success-strong/30',
    hoverBackground: 'hover:bg-success-subtle',
  },
  merged: {
    foreground: 'fg-special-strong',
    foregroundQuiet: 'fg-special-strong/70',
    foregroundMuted: 'fg-special-strong/80',
    background: 'bg-fg-special-strong',
    backgroundQuiet: 'bg-special-subtle',
    backgroundSubtle: 'bg-special-subtle',
    backgroundBadge: 'bg-special-subtle',
    backgroundMuted: 'bg-fg-special-strong/25',
    backgroundStrong: 'bg-special',
    border: 'border-fg-special-strong',
    ring: 'ring-fg-special-strong/20',
    ringQuiet: 'ring-fg-special-strong/10',
    borderSubtle: 'border-fg-special-strong/30',
    hoverBackground: 'hover:bg-special-subtle',
    hoverBackgroundStrong: 'hover:bg-special/90',
  },
  paused: {
    foreground: 'fg-secondary',
    foregroundQuiet: 'fg-secondary/70',
    foregroundMuted: 'fg-secondary/80',
    background: 'bg-fg-secondary',
    backgroundQuiet: 'bg-fg-secondary/16',
    backgroundSubtle: 'bg-fg-secondary/16',
    backgroundBadge: 'bg-fg-secondary/18',
    backgroundMuted: 'bg-fg-secondary/25',
    border: 'border-fg-secondary',
    ring: 'ring-fg-secondary/20',
    ringQuiet: 'ring-fg-secondary/10',
    borderMuted: 'border-fg-secondary/60',
    hoverBackground: 'hover:bg-fg-secondary/20',
  },
} as const;

/**
 * One generic blue for compact sidebar indicators. Their labels and tooltips
 * preserve status meaning; the rail itself deliberately avoids three nearly
 * identical operational/accent blues.
 */
export const SIDEBAR_INDICATOR_COLORS = {
  blue: 'fg-blue',
  destructive: 'fg-destructive',
  success: 'fg-success',
  purple: 'fg-purple',
  warning: 'fg-warning',
  neutral: 'fg-quaternary',
} as const;

export const SIDEBAR_INDICATOR_BLUE = {
  foreground: SIDEBAR_INDICATOR_COLORS.blue,
  background: 'bg-fg-blue',
} as const;

export type OperationalStatus = keyof typeof OPERATIONAL_STATUS_COLORS;
