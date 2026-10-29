import { VISUAL_STAGING_SWEEP_INTERVAL_MS } from './chat-visual-contracts';

export class ChatVisualStagingSweep {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  public constructor(private readonly sweep: () => Promise<void>) {}

  private runPass(): void {
    if (this.inFlight) return;
    let pass: Promise<void>;
    try {
      pass = this.sweep();
    } catch {
      return;
    }
    this.inFlight = pass;
    void pass
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlight === pass) this.inFlight = undefined;
      });
  }

  public start(): void {
    if (this.timer) return;
    this.runPass();
    this.timer = setInterval(
      () => this.runPass(),
      VISUAL_STAGING_SWEEP_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const pass = this.inFlight;
    if (pass) await pass.catch(() => undefined);
  }
}
