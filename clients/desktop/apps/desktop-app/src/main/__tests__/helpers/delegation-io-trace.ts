import {
  FileDelegationStorage,
  FileManagedDelegationMessageStorage,
} from '@canopy/desktop-shared/node/delegation/storage';
import type { DelegationRecordReader } from '../../agents/delegation/record-reader-contract';

export interface DelegationIoEntry {
  operation: string;
  scope: string;
  id: string | undefined;
  arguments: unknown;
  result?: unknown;
  failure?: unknown;
}

/**
 * Invocation order, including nested preparation and failures; setup is opt-in.
 * Only three volatile identities are normalized: the temporary-root prefix,
 * the recorded expected fresh actor epoch, and generated user-stop toolCallId nonces.
 * Per-run nonce tokens preserve identity and aliasing; other epochs stay literal.
 * Actor normalization is confined to broker call arguments, never stored records,
 * results or output. Nothing in record content, receipt bytes, user ids or order is masked.
 */
export class DelegationIoTrace {
  readonly entries: DelegationIoEntry[] = [];
  enabled = false;
  expectedFreshSessionEpoch: number | undefined;
  private readonly userStopNonces = new Map<string, string>();

  constructor(
    readonly scope: string,
    private readonly temporaryRoot: string,
  ) {}

  normalize(value: unknown): unknown {
    if (
      typeof value === 'object' &&
      value !== null &&
      'message' in value &&
      'name' in value
    )
      return {
        ...Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            this.normalize(item),
          ]),
        ),
        name: value.name,
        message: this.normalize(value.message),
      };
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (typeof value === 'string')
      return value.split(this.temporaryRoot).join('<TEMP_ROOT>');
    if (typeof value === 'function') return value.toString();
    if (Array.isArray(value)) return value.map((item) => this.normalize(item));
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.normalize(item)]),
      );
    return value;
  }

  private userStopNonce(value: string): string {
    let token = this.userStopNonces.get(value);
    if (!token) {
      token = `user-stop:<CALL_ID_${this.userStopNonces.size + 1}>`;
      this.userStopNonces.set(value, token);
    }
    return token;
  }

  private actorArgument(value: unknown): unknown {
    // Substitute only the recorded fresh epoch; preserve stale epochs and nonce aliasing.
    if (
      typeof value === 'object' &&
      value !== null &&
      'sessionKey' in value &&
      'harnessId' in value &&
      'depth' in value
    )
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          key === 'runtimeGeneration' &&
          this.expectedFreshSessionEpoch !== undefined &&
          item === this.expectedFreshSessionEpoch
            ? '<ACTOR_GENERATION>'
            : key === 'toolCallId' &&
                typeof item === 'string' &&
                item.startsWith('user-stop:')
              ? this.userStopNonce(item)
              : this.normalize(item),
        ]),
      );
    return this.normalize(value);
  }

  private begin(
    operation: string,
    id: string | undefined,
    args: unknown,
  ): DelegationIoEntry | undefined {
    if (!this.enabled) return undefined;
    const entry = {
      operation,
      scope: this.scope,
      id,
      arguments:
        operation.startsWith('broker.') && Array.isArray(args)
          ? args.map((argument: unknown, index: number) =>
              index === 0
                ? this.actorArgument(argument)
                : this.normalize(argument),
            )
          : this.normalize(args),
    };
    this.entries.push(entry);
    return entry;
  }

  sync<T>(
    operation: string,
    id: string | undefined,
    args: unknown,
    work: () => T,
  ): T {
    const entry = this.begin(operation, id, args);
    try {
      const result = work();
      if (entry) entry.result = this.normalize(result);
      return result;
    } catch (error) {
      if (entry) entry.failure = this.normalize(error);
      throw error;
    }
  }

  async call<T>(
    operation: string,
    id: string | undefined,
    args: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    const entry = this.begin(operation, id, args);
    try {
      const result = await work();
      if (entry) entry.result = this.normalize(result);
      return result;
    } catch (error) {
      if (entry) entry.failure = this.normalize(error);
      throw error;
    }
  }

  /** Spy through real instances, including receipt storage's nested file adapter. */
  storage(): void {
    const trace = { call: this.call.bind(this) };
    // Observe the real adapter's directory, including its receipt-file backing.
    // Reflection is test-only; the production storage API remains unchanged.
    const directoryOf = (storage: FileDelegationStorage): string => {
      const directory: unknown = Reflect.get(storage, 'directory');
      if (typeof directory !== 'string')
        throw new Error('Missing storage directory');
      return directory;
    };
    const files = FileDelegationStorage.prototype;
    const receipts = FileManagedDelegationMessageStorage.prototype;
    /* eslint-disable @typescript-eslint/unbound-method -- Originals below are always called with the live storage instance as receiver. */
    const prepare = files.prepareDirectory;
    const load = files.load;
    const loadOne = files.loadOne;
    const read = files.read;
    const commit = files.commit;
    const receiptLoad = receipts.load;
    const receiptCommit = receipts.commit;
    /* eslint-enable @typescript-eslint/unbound-method */
    jest.spyOn(files, 'prepareDirectory').mockImplementation(function (
      this: FileDelegationStorage,
    ) {
      return trace.call(
        'files.prepareDirectory',
        undefined,
        [directoryOf(this)],
        () => prepare.call(this),
      );
    });
    jest.spyOn(files, 'load').mockImplementation(function (
      this: FileDelegationStorage,
    ) {
      return trace.call('files.load', undefined, [directoryOf(this)], () =>
        load.call(this),
      );
    });
    jest.spyOn(files, 'loadOne').mockImplementation(function (
      this: FileDelegationStorage,
      id,
    ) {
      return trace.call('files.loadOne', id, [directoryOf(this), id], () =>
        loadOne.call(this, id),
      );
    });
    jest.spyOn(files, 'read').mockImplementation(function <T>(
      this: FileDelegationStorage,
      name: string,
      decode: (text: string, name: string) => T | undefined,
    ): Promise<T | undefined> {
      return trace.call(
        'files.read',
        name,
        [directoryOf(this), name, decode],
        () => read.bind(this)<T>(name, decode),
      );
    });
    jest.spyOn(files, 'commit').mockImplementation(function (
      this: FileDelegationStorage,
      record,
    ) {
      const id = 'state' in record ? record.state.delegationId : record.name;
      return trace.call('files.commit', id, [directoryOf(this), record], () =>
        commit.call(this, record),
      );
    });
    jest.spyOn(receipts, 'load').mockImplementation(function (
      this: FileManagedDelegationMessageStorage,
      id,
    ) {
      return trace.call('receipt.load', id, [id], () =>
        receiptLoad.call(this, id),
      );
    });
    jest.spyOn(receipts, 'commit').mockImplementation(function (
      this: FileManagedDelegationMessageStorage,
      receipt,
    ) {
      return trace.call(
        `receipt.${receipt.status}`,
        receipt.operationId,
        [receipt],
        () => receiptCommit.call(this, receipt),
      );
    });
  }

  /** No legacy entrypoint may reach even one reader method. */
  throwingReader(): DelegationRecordReader {
    const fail = (operation: string): never =>
      this.sync(`reader.${operation}`, undefined, [], () => {
        throw new Error(`Legacy reached ${operation}`);
      });
    return {
      resolveActivity: () => fail('resolveActivity'),
      resolveGenerationOutcome: () => fail('resolveGenerationOutcome'),
      resolveGenerationHeader: () => fail('resolveGenerationHeader'),
      resolveGenerationList: () => fail('resolveGenerationList'),
    };
  }
}
