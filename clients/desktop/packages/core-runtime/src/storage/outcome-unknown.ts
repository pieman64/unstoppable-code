/** Where an installed write lost its durability proof. */
export type StorageOutcomeUnknownStage = 'directory_flush';

export interface PortableStorageOutcomeUnknown {
  readonly name: 'StorageOutcomeUnknownError';
  readonly stage: StorageOutcomeUnknownStage;
  readonly namespaceId?: string;
}

/**
 * D8: the new content is installed and visible, but the sync that makes it
 * durable failed, so after a crash either the new or the previous content
 * may remain. As with a failed V2 group-commit batch, the write is not
 * acknowledged and the caller must not assume either outcome. Its portable
 * form names no host path and never serializes `cause`.
 */
export class StorageOutcomeUnknownError extends Error {
  public readonly stage: StorageOutcomeUnknownStage;
  public readonly namespaceId: string | undefined;
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare public readonly cause: unknown;

  public constructor(
    stage: StorageOutcomeUnknownStage,
    cause: unknown,
    namespaceId?: string,
  ) {
    super(
      `Storage write outcome unknown: installed, then its ${stage.replace('_', ' ')} failed${
        namespaceId === undefined ? '' : ` (${namespaceId})`
      }`,
    );
    this.name = 'StorageOutcomeUnknownError';
    this.stage = stage;
    this.namespaceId = namespaceId;
    this.cause = cause;
  }

  public toJSON(): PortableStorageOutcomeUnknown {
    return {
      name: 'StorageOutcomeUnknownError',
      stage: this.stage,
      ...(this.namespaceId === undefined
        ? {}
        : { namespaceId: this.namespaceId }),
    };
  }
}

export function isStorageOutcomeUnknownError(
  error: unknown,
): error is StorageOutcomeUnknownError {
  return error instanceof StorageOutcomeUnknownError;
}
