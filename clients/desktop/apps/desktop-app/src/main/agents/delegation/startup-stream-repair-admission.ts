/** One in-flight stream-repair owner for each delegation runs directory. */
export class StartupStreamRepairAdmissions {
  private readonly pending = new Map<string, Promise<void>>();

  begin(directory: string): (() => void) | undefined {
    if (this.pending.has(directory)) return undefined;
    let release: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.set(directory, completion);
    return (): void => {
      if (this.pending.get(directory) === completion)
        this.pending.delete(directory);
      release();
    };
  }

  wait(directory: string): Promise<void> | undefined {
    return this.pending.get(directory);
  }

  async drain(): Promise<void> {
    await Promise.all(Array.from(this.pending.values()));
  }
}
