import {
  createW5SingleDecisionOperation as createCoreW5SingleDecisionOperation,
  type W5SingleDecisionBindings,
  type W5SingleDecisionInput,
  type W5SingleDecisionOperation,
} from '@canopy/core-runtime/node/w5/single-decision-operation';
import { CanopyOperationError } from '@canopy/core-runtime';
import { w5DaemonReceiptCaller } from '@canopy/core-runtime/node/w5/workspace-metadata/receipt-caller';
import { IdentifierValidationError } from './validation';
import type { W5CommitOptions } from './w5-commit-scope';
import { runKeyedW5Operation } from './w5-keyed-operation';
import { runW5DecisionOnlyUnit } from './w5-pre-effect-retry';
import { withStorageAdmission } from './w5-storage';

export type {
  W5SingleDecisionInput,
  W5SingleDecisionOperation,
} from '@canopy/core-runtime/node/w5/single-decision-operation';

/**
 * Desktop main's one-decision bindings: a keyed receipt names its caller
 * `desktop-host:<source>`, an invalid identifier is a safe refusal, and
 * storage admission is the shared desktop admission. Each binding resolves
 * at call time, so test spies still intercept.
 */
export function desktopW5SingleDecisionBindings<
  Source extends string,
>(): W5SingleDecisionBindings<Source> {
  return {
    runKeyed: (input, decode, work) => runKeyedW5Operation(input, decode, work),
    admitStorage: (targets, run) => withStorageAdmission(targets, run),
    caller: (source) => `desktop-host:${source}`,
    isHostRefusal: (error) => error instanceof IdentifierValidationError,
  };
}

/**
 * One wire call of a registered guarded command (W7b-1b), which its host
 * resolves before calling the boundary.
 */
export interface W5WireDecisionCall<Outcome = unknown> {
  /** The authenticated principal its receipts name. */
  readonly principalId: string;
  /**
   * Addressing for a new key only: after the receipt lookup and before the
   * reservation (RR5), so a refusal consumes no key.
   */
  readonly admitAddress?: () => Promise<void>;
  /**
   * Checks the outcome inside the decision, before it commits, so an outcome
   * the wire result cannot carry refuses there and releases the key.
   */
  readonly admitOutcome?: (outcome: Outcome) => void;
}

/**
 * The desktop bindings for one wire call: a keyed receipt names
 * `daemon:<principalId>:<source>` (CAN-5522's derivation, as the W7a
 * metadata commands), and a `CanopyOperationError` the host throws before
 * the decision is a refusal, releasing the key.
 */
function wireW5SingleDecisionBindings<Source extends string>(
  wire: W5WireDecisionCall<never>,
): W5SingleDecisionBindings<Source> {
  const bindings = desktopW5SingleDecisionBindings<Source>();
  const { admitAddress } = wire;
  return {
    ...bindings,
    runKeyed: (input, decode, work) =>
      bindings.runKeyed(
        admitAddress
          ? {
              ...input,
              admit: async () => {
                await admitAddress();
                await input.admit?.();
              },
            }
          : input,
        decode,
        work,
      ),
    caller: (source) => w5DaemonReceiptCaller(wire.principalId, source),
    isHostRefusal: (error) =>
      bindings.isHostRefusal(error) || error instanceof CanopyOperationError,
  };
}

/**
 * The core one-decision runner bound to desktop main; with `wire`, bound to
 * that wire call instead.
 */
export function createW5SingleDecisionOperation<Source extends string>(
  isBoundaryRefusal: (error: unknown) => boolean,
  wire?: W5WireDecisionCall<never>,
): W5SingleDecisionOperation<Source> {
  return createCoreW5SingleDecisionOperation<Source>(
    wire
      ? wireW5SingleDecisionBindings<Source>(wire)
      : desktopW5SingleDecisionBindings<Source>(),
    isBoundaryRefusal,
  );
}

/** `decode`, checked by the wire call's `admitOutcome` when it has one. */
export function wireW5Decode<T>(
  decode: (outcome: unknown) => T,
  wire: W5WireDecisionCall<T> | undefined,
): (outcome: unknown) => T {
  const admitOutcome = wire?.admitOutcome;
  if (!admitOutcome) return decode;
  return (outcome) => {
    const decoded = decode(outcome);
    admitOutcome(decoded);
    return decoded;
  };
}

/**
 * `run` with each call one outermost decision-only unit labelled by its
 * operation (W5d2, CAN-5535). Only for a guarded command whose host steps
 * before the decision are repeat-safe.
 */
export function withW5DecisionOnlyRetry<Source extends string>(
  run: W5SingleDecisionOperation<Source>,
): W5SingleDecisionOperation<Source> {
  return function runW5DecisionOnly<A, T>(
    input: W5SingleDecisionInput<Source>,
    admit: () => Promise<A>,
    decode: (outcome: unknown) => T,
    execute: (
      admitted: A,
      options: W5CommitOptions,
      save: (result: T) => T,
    ) => Promise<T>,
  ): Promise<T> {
    return runW5DecisionOnlyUnit(input.operation, () =>
      run(input, admit, decode, execute),
    );
  };
}
