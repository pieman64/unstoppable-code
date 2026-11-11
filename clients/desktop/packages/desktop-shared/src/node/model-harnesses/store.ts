import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { getModelHarnessOverridesFilePath } from '@canopy/execution-engine/canopy-paths';
import {
  damagedCopiesOf,
  pruneDamagedCopies,
} from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  MODEL_HARNESS_OVERRIDES_VERSION,
  ModelHarnessPolicyError,
  applyModelHarnessOverrideMutation,
  isAssignableModelHarness,
  isSyntacticallyValidModelId,
  normalizeModelHarnessOverrides,
  type ModelHarness,
  type ModelHarnessCatalog,
  type ModelHarnessOverridesFile,
} from '@canopy/execution-engine/model-harnesses';

export class UnsupportedModelHarnessOverridesVersionError extends Error {
  constructor(readonly version: number) {
    super(
      `Model harness overrides version ${String(version)} is newer than this application supports`,
    );
    this.name = 'UnsupportedModelHarnessOverridesVersionError';
  }
}

export interface ModelHarnessOverrideStoreOptions {
  filePath?: string;
  getCatalog: () => ModelHarnessCatalog;
  now?: () => Date;
  /** Optional recovery backend, primarily for deterministic fault injection. */
  healCorruptFile?: () => Promise<void>;
}

export interface ModelHarnessOverrideMutationResult {
  modelId: string;
  overrides: Record<string, ModelHarness>;
  changed: boolean;
}

function cloneOverrides(
  overrides: Readonly<Record<string, ModelHarness>>,
): Record<string, ModelHarness> {
  return { ...overrides };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyValidOverrideEntries(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([modelId, harness]) =>
        isSyntacticallyValidModelId(modelId) &&
        isAssignableModelHarness(harness),
    )
  );
}

function serialize(overrides: Record<string, ModelHarness>): string {
  const document: ModelHarnessOverridesFile = {
    version: MODEL_HARNESS_OVERRIDES_VERSION,
    overrides: Object.fromEntries(
      Object.entries(overrides).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export class ModelHarnessOverrideStore {
  readonly filePath: string;
  private readonly getCatalog: () => ModelHarnessCatalog;
  private readonly now: () => Date;
  private readonly healCorruptFile?: () => Promise<void>;
  private loaded = false;
  private loadPromise: Promise<Record<string, ModelHarness>> | undefined;
  private overrides: Record<string, ModelHarness> = {};
  private needsCleanup = false;
  private unsupportedVersion: number | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: ModelHarnessOverrideStoreOptions) {
    this.filePath = options.filePath ?? getModelHarnessOverridesFilePath();
    this.getCatalog = options.getCatalog;
    this.now = options.now ?? ((): Date => new Date());
    this.healCorruptFile = options.healCorruptFile;
  }

  async load(): Promise<Record<string, ModelHarness>> {
    if (this.loaded) return cloneOverrides(this.overrides);
    this.loadPromise ??= this.loadFromDisk();
    return cloneOverrides(await this.loadPromise);
  }

  getCachedOverrides(): Record<string, ModelHarness> {
    return cloneOverrides(this.overrides);
  }

  getUnsupportedVersion(): number | undefined {
    return this.unsupportedVersion;
  }

  set(
    modelId: string,
    harness: ModelHarness,
  ): Promise<ModelHarnessOverrideMutationResult> {
    return this.enqueueMutation(() =>
      this.mutate({ modelId, harness, reset: false }),
    );
  }

  reset(modelId: string): Promise<ModelHarnessOverrideMutationResult> {
    return this.enqueueMutation(() => this.mutate({ modelId, reset: true }));
  }

  private async loadFromDisk(): Promise<Record<string, ModelHarness>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      // Harness overrides are optional user preferences. An unreadable file
      // must not poison the memoized load promise or abort desktop startup;
      // treat it exactly like a missing/corrupt preference file. A later
      // mutation still writes a clean authoritative document atomically.
      this.loaded = true;
      return this.overrides;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.recoverCorruptFileBestEffort();
      this.loaded = true;
      return this.overrides;
    }

    if (
      isRecord(parsed) &&
      typeof parsed.version === 'number' &&
      Number.isInteger(parsed.version) &&
      parsed.version > MODEL_HARNESS_OVERRIDES_VERSION
    ) {
      this.unsupportedVersion = parsed.version;
      this.loaded = true;
      return this.overrides;
    }

    if (
      !isRecord(parsed) ||
      parsed.version !== MODEL_HARNESS_OVERRIDES_VERSION ||
      !isRecord(parsed.overrides)
    ) {
      await this.recoverCorruptFileBestEffort();
      this.loaded = true;
      return this.overrides;
    }

    this.overrides = normalizeModelHarnessOverrides(
      parsed.overrides,
      this.getCatalog().modelAliases,
    );
    this.needsCleanup = !hasOnlyValidOverrideEntries(parsed.overrides);
    this.loaded = true;
    return this.overrides;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async mutate(input: {
    modelId: string;
    harness?: ModelHarness;
    reset: boolean;
  }): Promise<ModelHarnessOverrideMutationResult> {
    await this.load();
    if (this.unsupportedVersion !== undefined) {
      throw new UnsupportedModelHarnessOverridesVersionError(
        this.unsupportedVersion,
      );
    }
    const result = applyModelHarnessOverrideMutation({
      ...input,
      catalog: this.getCatalog(),
      overrides: this.overrides,
    });
    const changed =
      JSON.stringify(result.overrides) !== JSON.stringify(this.overrides);
    if (changed || this.needsCleanup) {
      await this.atomicWrite(result.overrides);
      this.overrides = result.overrides;
      this.needsCleanup = false;
    }
    return {
      modelId: result.modelId,
      overrides: cloneOverrides(this.overrides),
      changed,
    };
  }

  private async backupAndReplaceCorruptFile(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${this.filePath}.corrupt-${stamp}.bak`;
    await rename(this.filePath, backupPath);
    await pruneDamagedCopies(
      damagedCopiesOf(this.filePath, '.corrupt-', { suffix: '.bak' }),
    );
    await this.atomicWrite({});
    this.overrides = {};
    this.needsCleanup = false;
  }

  private async recoverCorruptFileBestEffort(): Promise<void> {
    try {
      await (this.healCorruptFile?.() ?? this.backupAndReplaceCorruptFile());
    } catch {
      // Harness overrides are optional preferences. Failure to heal a corrupt
      // file must not poison the memoized load promise or abort startup. Keep
      // the in-memory state empty and retry cleanup on the next mutation.
      this.overrides = {};
      this.needsCleanup = true;
    }
  }

  private async atomicWrite(
    overrides: Record<string, ModelHarness>,
  ): Promise<void> {
    const parent = dirname(this.filePath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
      const handle = await open(tempPath, 'wx', 0o600);
      try {
        await handle.writeFile(serialize(overrides), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await chmod(this.filePath, 0o600);
    // Make the write contract explicit for tests and unusual filesystems.
    await access(this.filePath, constants.R_OK | constants.W_OK);
  }
}

export function isModelHarnessPolicyError(
  error: unknown,
): error is ModelHarnessPolicyError {
  return error instanceof ModelHarnessPolicyError;
}
