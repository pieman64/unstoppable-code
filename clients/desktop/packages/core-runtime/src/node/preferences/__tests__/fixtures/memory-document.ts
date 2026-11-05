import type {
  PreferencesDocument,
  PreferencesDocumentSlot,
} from '../../document';

export class MemoryPreferencesDocument implements PreferencesDocument {
  readonly slots = new Map<PreferencesDocumentSlot, string>();
  readonly readFailures = new Map<PreferencesDocumentSlot, Error>();
  readonly installFailures = new Map<PreferencesDocumentSlot, Error>();
  readonly installs: {
    slot: PreferencesDocumentSlot | 'backup';
    content: string;
  }[] = [];
  readonly backups = new Map<string, string>();
  private readonly gates = new Map<
    PreferencesDocumentSlot,
    { started(): void; wait: Promise<void> }
  >();

  constructor(readonly key: string = 'memory-document') {}

  exists(slot: 'primary' | 'lastGood'): Promise<boolean> {
    const failure = this.readFailures.get(slot);
    if (failure) {
      if ('code' in failure && failure.code === 'ENOENT')
        return Promise.resolve(false);
      return Promise.reject(failure);
    }
    return Promise.resolve(this.slots.has(slot));
  }

  ensureFolder(): Promise<void> {
    return Promise.resolve();
  }

  slotPath(slot: PreferencesDocumentSlot): string {
    return `${this.key}/${slot}`;
  }

  backupLocation(stamp: string): string {
    return `${this.key}/backup-${stamp}`;
  }

  installBackup(location: string, content: string): Promise<void> {
    this.installs.push({ slot: 'backup', content });
    this.backups.set(location, content);
    return Promise.resolve();
  }

  pruneBackups(): Promise<void> {
    while (this.backups.size > 5) {
      const oldest = this.backups.keys().next().value;
      if (oldest === undefined) break;
      this.backups.delete(oldest);
    }
    return Promise.resolve();
  }

  readText(slot: PreferencesDocumentSlot): Promise<string> {
    const failure = this.readFailures.get(slot);
    if (failure) return Promise.reject(failure);
    const value = this.slots.get(slot);
    return value === undefined
      ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      : Promise.resolve(value);
  }

  async install(slot: PreferencesDocumentSlot, content: string): Promise<void> {
    this.installs.push({ slot, content });
    const gate = this.gates.get(slot);
    if (gate) {
      gate.started();
      await gate.wait;
    }
    const failure = this.installFailures.get(slot);
    if (failure) throw failure;
    this.slots.set(slot, content);
  }

  holdInstall(slot: PreferencesDocumentSlot): {
    started: Promise<void>;
    release(): void;
  } {
    let release = (): void => undefined;
    let started = (): void => undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    this.gates.set(slot, { started, wait });
    return {
      started: began,
      release: (): void => {
        this.gates.delete(slot);
        release();
      },
    };
  }
}
