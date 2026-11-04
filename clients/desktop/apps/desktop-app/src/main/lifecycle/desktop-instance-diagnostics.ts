import { BRAND } from '@canopy/brand/current';
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';

type DesktopInstanceEvent =
  | { event: 'owner-acquired' | 'contender-rejected' | 'app-ready' }
  | { event: 'second-instance'; windowId: number | null }
  | { event: 'provider-cleanup-started'; provider: 'codex' | 'claude' }
  | { event: 'window-focused'; windowId: number }
  | {
      event: 'link-delivered';
      windowId: number;
      destination: 'settings';
    };

let profileHash: string | undefined;

/** Local lifecycle receipts: no URLs, argv, profile paths or credentials. */
export function recordDesktopInstanceEvent(event: DesktopInstanceEvent): void {
  if (__CANOPY_E2E__) return;
  try {
    profileHash ??= createHash('sha256')
      .update(app.getPath('userData'))
      .digest('hex');
    // stdout also works before logging starts, so a rejected contender never
    // opens the owner's log or initializes a profile service to record its exit.
    writeSync(
      process.stdout.fd,
      `[desktop-instance] ${JSON.stringify({
        schema: 1,
        ...event,
        at: Date.now(),
        pid: process.pid,
        brand: BRAND.internalName,
        profileHash,
      })}\n`,
    );
  } catch {
    // Diagnostics must never prevent protocol forwarding or startup.
  }
}
