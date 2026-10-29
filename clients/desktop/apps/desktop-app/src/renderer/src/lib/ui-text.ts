/**
 * Catalog of platform-dependent UI strings.
 *
 * Each entry is either a plain string (same on every platform) or a
 * `PlatformText<string>` object with a `default` plus per-platform overrides.
 * Resolve entries with `pt(uiText...)` from `./platform-text`.
 *
 * Rules of thumb:
 * - Use native platform terminology ("Finder" vs "File Explorer") rather than
 *   generic wording.
 * - Each visible string must be a complete sentence per platform — never
 *   assemble sentences from fragments at runtime.
 * - Only platform-dependent copy belongs here. Generic strings stay in the
 *   call site they originated from.
 * - Brand-aware copy reads `brandText.appName` / `brandText.cliName` from
 *   `@/lib/brand`. Entries are exposed as object getters so the resolution
 *   happens lazily at access time and stays compatible with `pt(...)`.
 */

import type { PlatformText } from './platform-text';
import { brandText } from './brand';

type UiTextEntry = PlatformText<string>;

const shellIntegration = {
  title: {
    darwin: 'Shell integration',
    win32: 'Command-line integration',
    default: 'Shell integration',
  } satisfies UiTextEntry,
  checking: {
    darwin: 'Checking CLI shell integration…',
    win32: 'Checking CLI command-line integration…',
    default: 'Checking CLI integration…',
  } satisfies UiTextEntry,
  unsupportedDev: 'CLI PATH installation is unavailable in development mode.',
  unsupportedPlatform: {
    darwin: 'Shell integration is only available on packaged macOS builds.',
    win32:
      'Command-line integration is only available on packaged Windows builds.',
    default: 'CLI integration is unavailable on this platform.',
  } satisfies UiTextEntry,
  get missing(): UiTextEntry {
    return {
      darwin: `The ${brandText.appName} CLI is not currently installed in /usr/local/bin.`,
      win32: `The ${brandText.appName} CLI is not currently available from your user PATH.`,
      default: `The ${brandText.appName} CLI is not currently installed on PATH.`,
    };
  },
  get installed(): UiTextEntry {
    return {
      darwin: `The ${brandText.appName} CLI is installed at /usr/local/bin/${brandText.cliName}.`,
      win32: `The ${brandText.appName} CLI is available from your user PATH.`,
      default: `The ${brandText.appName} CLI is installed on PATH.`,
    };
  },
  addButton: {
    darwin: 'Add to PATH',
    win32: 'Add to user PATH',
    default: 'Add to PATH',
  } satisfies UiTextEntry,
  removeButton: {
    darwin: 'Remove from PATH',
    win32: 'Remove from user PATH',
    default: 'Remove from PATH',
  } satisfies UiTextEntry,
  get addSuccess(): UiTextEntry {
    return {
      darwin: `Added ${brandText.appName} to /usr/local/bin.`,
      win32: `Added ${brandText.appName} to your user PATH. Restart open terminals to use it.`,
      default: `Added ${brandText.appName} to PATH.`,
    };
  },
  get removeSuccess(): UiTextEntry {
    return {
      darwin: `Removed ${brandText.appName} from /usr/local/bin.`,
      win32: `Removed ${brandText.appName} from your user PATH. Restart open terminals to pick up the change.`,
      default: `Removed ${brandText.appName} from PATH.`,
    };
  },
  get foreignSymlink(): UiTextEntry {
    return {
      darwin: `A different symlink already occupies /usr/local/bin/${brandText.cliName}.`,
      win32: `A different entry already occupies the ${brandText.appName} slot in your user PATH.`,
      default: `A different entry already occupies the managed ${brandText.appName} CLI location.`,
    };
  },
  get regularFile(): UiTextEntry {
    return {
      darwin: `A file already occupies /usr/local/bin/${brandText.cliName}.`,
      win32: `A file already occupies the ${brandText.appName} slot in your user PATH.`,
      default: `A file already occupies the managed ${brandText.appName} CLI location.`,
    };
  },
  get manualRemovalHelper(): UiTextEntry {
    return {
      darwin: `Remove the existing entry at /usr/local/bin/${brandText.cliName} manually before installing the ${brandText.appName} CLI.`,
      win32: `Remove the existing entry from your user PATH manually before installing the ${brandText.appName} CLI.`,
      default: `Remove the existing entry manually before installing the ${brandText.appName} CLI.`,
    };
  },
  get managedPathLabel(): UiTextEntry {
    return {
      darwin: `/usr/local/bin/${brandText.cliName}`,
      win32: 'user PATH entry',
      default: 'managed CLI path',
    };
  },
};

export const uiText = {
  fileManager: {
    showItem: {
      darwin: 'Show in Finder',
      win32: 'Show in File Explorer',
      linux: 'Show in Files',
      default: 'Show in folder',
    } satisfies UiTextEntry,
    openItem: {
      darwin: 'Open in Finder',
      win32: 'Open in File Explorer',
      linux: 'Open in Files',
      default: 'Open in file manager',
    } satisfies UiTextEntry,
    revealRemainder: {
      darwin: 'Open in Finder to view the rest.',
      win32: 'Open in File Explorer to view the rest.',
      linux: 'Open in Files to view the rest.',
      default: 'Open in your file manager to view the rest.',
    } satisfies UiTextEntry,
  },
  officePreview: {
    banner: {
      darwin:
        'Semantic preview: formatting may differ; open in Finder for the exact document.',
      win32:
        'Semantic preview: formatting may differ; open in File Explorer for the exact document.',
      linux:
        'Semantic preview: formatting may differ; open in Files for the exact document.',
      default:
        'Semantic preview: formatting may differ; open the original file for the exact document.',
    } satisfies UiTextEntry,
    truncationRecovery:
      'Open the workbook in its native app to see everything.',
    parseFailedRecovery: 'Open it in its native app to view the full document.',
  },
  shellIntegration,
  pipelineShell: {
    unsetDefault: {
      darwin: 'Default (Bash)',
      win32: 'Default (PowerShell)',
      linux: 'Default (Bash)',
      default: 'Default',
    } satisfies UiTextEntry,
  },
  dictation: {
    navLabel: 'Dictation',
  },
  applications: {
    heading: 'Applications',
    helper: 'Manage which applications appear in the Open dropdown.',
    detecting: {
      darwin: 'Detecting applications…',
      win32: 'Detecting applications…',
      default: 'Detecting applications…',
    } satisfies UiTextEntry,
    empty: {
      darwin: 'No apps detected',
      win32: 'No supported applications detected',
      default: 'No applications detected',
    } satisfies UiTextEntry,
  },
  launchAtLogin: {
    // Says "sign in", never "log in": the sign-in copy check rejects the
    // other wording in anything rendered (docs/ux-writing.md).
    get toggleLabel(): UiTextEntry {
      return {
        darwin: `Open ${brandText.appName} when you sign in to your Mac`,
        win32: `Open ${brandText.appName} when you sign in to Windows`,
        default: `Open ${brandText.appName} when you sign in`,
      };
    },
  },
  notifications: {
    permissionHelper: {
      darwin:
        'macOS will prompt for permission the first time a notification fires. Manage it later in System Settings → Notifications.',
      win32:
        'Windows will prompt or show notifications according to your system notification settings. Manage it later in Windows Settings → System → Notifications.',
      default: 'Your system controls notification permission and delivery.',
    } satisfies UiTextEntry,
    failure: {
      darwin:
        'Could not send notification. Check System Settings → Notifications.',
      win32:
        'Could not send notification. Check Windows Settings → System → Notifications.',
      default:
        'Could not send notification. Check your system notification settings.',
    } satisfies UiTextEntry,
  },
} as const;
