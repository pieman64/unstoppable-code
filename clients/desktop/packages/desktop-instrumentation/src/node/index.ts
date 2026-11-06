// Node instrumentation entry for headless hosts, beside `./electron/main`
// (CAN-4136). It has the operation and error surface observability reports
// through and applies the same context redaction as the Electron entry, but
// owns no telemetry transport: records go to the host's sink, or nowhere.
// Portable telemetry policy, buffering and drain belong to CAN-4179.
import type { DesktopOperationName } from '../operations';
import { redactText, sanitizeExternalInstrumentationContext } from '../privacy';
import type {
  DesktopInstrumentationContext,
  DesktopInstrumentationErrorOptions,
  DesktopInstrumentationFailureReason,
  DesktopInstrumentationOperationOptions,
} from '../types';

export type NodeInstrumentationRecord =
  | {
      kind: 'operation_started' | 'operation_succeeded';
      name: DesktopOperationName;
      operationKey?: string;
      context?: DesktopInstrumentationContext;
    }
  | {
      kind: 'operation_failed';
      name: DesktopOperationName;
      failureReason: DesktopInstrumentationFailureReason;
      operationKey?: string;
      context?: DesktopInstrumentationContext;
    }
  | {
      kind: 'error';
      message: string;
      context?: DesktopInstrumentationContext;
    };

export interface NodeInstrumentationOptions {
  /** Receives every redacted record. Without one, records are dropped. */
  sink?: (record: NodeInstrumentationRecord) => void;
}

export interface NodeInstrumentation {
  startOperation(
    name: DesktopOperationName,
    options?: DesktopInstrumentationOperationOptions,
  ): void;
  succeedOperation(
    name: DesktopOperationName,
    options?: DesktopInstrumentationOperationOptions,
  ): void;
  failOperation(
    name: DesktopOperationName,
    failureReason: DesktopInstrumentationFailureReason,
    options?: DesktopInstrumentationOperationOptions,
  ): void;
  captureError(
    error: unknown,
    options?: DesktopInstrumentationErrorOptions,
  ): void;
}

function operationFields(
  options: DesktopInstrumentationOperationOptions | undefined,
): { operationKey?: string; context?: DesktopInstrumentationContext } {
  const context = sanitizeExternalInstrumentationContext(options?.context);
  return {
    ...(options?.operationKey === undefined
      ? {}
      : { operationKey: options.operationKey }),
    ...(context === undefined ? {} : { context }),
  };
}

export function createNodeInstrumentation(
  options: NodeInstrumentationOptions = {},
): NodeInstrumentation {
  const emit = (build: () => NodeInstrumentationRecord): void => {
    const sink = options.sink;
    if (!sink) return;
    try {
      sink(build());
    } catch {
      // Instrumentation must never affect the host path.
    }
  };
  return {
    startOperation: (name, operationOptions): void => {
      emit(() => ({
        kind: 'operation_started',
        name,
        ...operationFields(operationOptions),
      }));
    },
    succeedOperation: (name, operationOptions): void => {
      emit(() => ({
        kind: 'operation_succeeded',
        name,
        ...operationFields(operationOptions),
      }));
    },
    failOperation: (name, failureReason, operationOptions): void => {
      emit(() => ({
        kind: 'operation_failed',
        name,
        failureReason,
        ...operationFields(operationOptions),
      }));
    },
    captureError: (error, errorOptions): void => {
      emit(() => {
        const context = sanitizeExternalInstrumentationContext(
          errorOptions?.context,
        );
        return {
          kind: 'error',
          message: redactText(
            error instanceof Error ? error.message : String(error),
          ),
          ...(context === undefined ? {} : { context }),
        };
      });
    },
  };
}
