import type { Session } from 'electron';
import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';

/** The sole onBeforeRequest owner for each browser Session. Other policy checks compose here. */
export class BrowserProfileNetworkPolicy {
  private paused = false;
  private readonly controls = new Set<number>();
  constructor(native: Session) {
    native.webRequest.onBeforeRequest((details, callback) => {
      callback({
        cancel:
          this.paused &&
          (details.webContentsId === undefined ||
            !this.controls.has(details.webContentsId)),
      });
    });
  }
  get hasControls(): boolean {
    return this.controls.size > 0;
  }
  fence(): void {
    this.paused = true;
  }
  allowControl(contentsId: number): () => void {
    if (!this.paused || !Number.isSafeInteger(contentsId) || contentsId <= 0)
      throw new BrowserProfileError(
        'operation_conflict',
        'Storage verification requires a paused profile.',
      );
    this.controls.add(contentsId);
    return () => {
      this.controls.delete(contentsId);
    };
  }
  resume(): void {
    if (this.controls.size)
      throw new BrowserProfileError(
        'operation_conflict',
        'Storage verification is still active.',
      );
    this.paused = false;
  }
}
