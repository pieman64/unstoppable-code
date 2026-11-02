import type { McpSessionBinding } from './session-availability';

/** Host-only two-phase handoff. It is never serialized or accepted from an interface. */
export class McpActivationHandoff {
  readonly prepared: Promise<McpSessionBinding>;
  readonly admission: Promise<'accepted' | 'not_sent' | 'uncertain'>;
  private readonly permission: Promise<void>;
  private preparedResolve!: (binding: McpSessionBinding) => void;
  private preparedReject!: (error: unknown) => void;
  private permissionResolve!: () => void;
  private permissionReject!: (error: unknown) => void;
  private admissionResolve!: (
    admission: 'accepted' | 'not_sent' | 'uncertain',
  ) => void;
  private binding?: McpSessionBinding;
  private released = false;
  private sent = false;
  private settled = false;
  get pending(): boolean {
    return !this.settled;
  }

  constructor(
    readonly generation: number,
    readonly userMessageId: string,
    readonly signal: AbortSignal,
    private readonly canSend: () => Promise<boolean> = (): Promise<boolean> =>
      Promise.resolve(true),
  ) {
    this.prepared = new Promise((resolve, reject) => {
      this.preparedResolve = resolve;
      this.preparedReject = reject;
    });
    this.permission = new Promise((resolve, reject) => {
      this.permissionResolve = resolve;
      this.permissionReject = reject;
    });
    this.admission = new Promise((resolve) => {
      this.admissionResolve = resolve;
    });
    void this.prepared.catch(() => {});
    void this.permission.catch(() => {});
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  preparedSession(binding: McpSessionBinding): void {
    this.signal.throwIfAborted();
    if (this.binding || binding.generation !== this.generation)
      throw new Error('MCP activation session changed');
    this.binding = binding;
    this.preparedResolve(binding);
  }

  async beforePrompt(userMessageId: string | undefined): Promise<void> {
    if (this.settled || userMessageId !== this.userMessageId || !this.binding)
      throw new Error('MCP activation task changed');
    await this.permission;
    if (!(await this.canSend())) {
      this.failed();
      throw new Error('MCP activation task changed');
    }
    this.signal.throwIfAborted();
    if (this.settled) throw new Error('MCP activation task changed');
    if (this.sent) throw new Error('MCP activation was already submitted');
    this.sent = true;
  }

  dispatch(): Promise<'accepted' | 'not_sent' | 'uncertain'> {
    this.signal.throwIfAborted();
    if (!this.released) {
      this.released = true;
      this.permissionResolve();
    }
    return this.admission;
  }

  accepted(): void {
    if (this.sent && !this.signal.aborted) this.finish('accepted');
  }

  failed(): void {
    this.preparedReject(new Error('MCP activation preparation failed'));
    this.permissionReject(new Error('MCP activation preparation failed'));
    this.finish(this.sent ? 'uncertain' : 'not_sent');
  }

  private readonly abort = (): void => {
    this.failed();
  };

  private finish(result: 'accepted' | 'not_sent' | 'uncertain'): void {
    if (this.settled) return;
    this.settled = true;
    this.signal.removeEventListener('abort', this.abort);
    this.admissionResolve(result);
  }
}
