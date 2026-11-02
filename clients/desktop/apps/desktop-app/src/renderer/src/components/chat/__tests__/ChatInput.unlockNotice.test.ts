/**
 * Source-level guard (CAN-5030): `ChatInput.tsx` is too store/IPC-bound to
 * mount in jsdom, so this pins where the pending-purchase notice is mounted.
 * The Electron recovery flow proves the notice renders in the real composer.
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const source = readFileSync(join(__dirname, '..', 'ChatInput.tsx'), 'utf8');

/** The composer notice stack's JSX, from its opening tag to its closing one. */
function noticeStack(): string {
  const start = source.indexOf('<ComposerNoticeStack');
  const end = source.indexOf('</ComposerNoticeStack>', start);
  if (start < 0 || end < 0) throw new Error('ComposerNoticeStack not found');
  return source.slice(start, end);
}

describe('ChatInput pending purchase notice', () => {
  it('mounts once in the composer notice stack, keyed to the chat', () => {
    const stack = noticeStack();
    const mounts = stack.match(/<ModelUnlockPendingBanner\b[^>]*\/>/g) ?? [];
    expect(mounts).toEqual(['<ModelUnlockPendingBanner chatId={tabId} />']);
    expect(source.match(/<ModelUnlockPendingBanner\b/g)).toHaveLength(1);
  });

  it('sits after the billing notices and outside their queued-edit guard', () => {
    const stack = noticeStack();
    const mount = stack.indexOf('<ModelUnlockPendingBanner');
    const billing = stack.indexOf('<SubscriptionAvailabilityNotice');
    expect(billing).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(billing);
    // The billing fragment closes (`</>` then `)}`) before the mount, and
    // nothing between them reopens a `!isEditingQueued` guard.
    const between = stack.slice(stack.lastIndexOf('</>', mount), mount);
    expect(between).toMatch(/^<\/>\s*\)\}/);
    expect(between).not.toContain('isEditingQueued');
  });
});
