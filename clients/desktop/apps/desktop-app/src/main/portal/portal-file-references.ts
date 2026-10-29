import { randomUUID } from 'node:crypto';
import type { PortalChatFileReference } from '@canopy/protocol/portal';
import type { HostPortalChatFileReference } from '@canopy/desktop-shared/types';
import { PortalServiceError } from '../services/portal-service-error';

export interface PortalFileReferenceScope {
  sessionId: string;
  projectId: string;
  worktreeId: string;
  canRead?: () => boolean;
}

interface RegistryEntry {
  scope: PortalFileReferenceScope;
  file: HostPortalChatFileReference;
  expiresAt: number;
  key: string;
}

export class PortalFileReferenceRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly index = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly now: () => number;
  private readonly capacity: number;
  private readonly ttlMs: number;

  constructor(
    options: { now?: () => number; capacity?: number; ttlMs?: number } = {},
  ) {
    this.now = options.now ?? ((): number => Date.now());
    this.capacity = options.capacity ?? 4096;
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    if (
      !Number.isSafeInteger(this.capacity) ||
      this.capacity < 1 ||
      !Number.isSafeInteger(this.ttlMs) ||
      this.ttlMs < 1
    ) {
      throw new Error('Invalid file reference registry limits.');
    }
  }

  mint(
    scope: PortalFileReferenceScope,
    file: HostPortalChatFileReference,
  ): PortalChatFileReference {
    this.authorize(scope);
    this.prune();
    const key = JSON.stringify([
      scope.sessionId,
      scope.projectId,
      scope.worktreeId,
      file.absolutePath,
    ]);
    const existing = this.index.get(key);
    const referenceId = existing ?? randomUUID();
    if (!existing && this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.remove(oldest);
    }
    this.entries.set(referenceId, {
      scope: { ...scope },
      file: { ...file },
      expiresAt: this.now() + this.ttlMs,
      key,
    });
    this.index.set(key, referenceId);
    this.schedule();
    return {
      referenceId,
      displayPath: file.displayPath,
      ...(file.repoName !== undefined ? { repoName: file.repoName } : {}),
      ...(file.kind !== undefined ? { kind: file.kind } : {}),
      ...(file.textStart !== undefined ? { textStart: file.textStart } : {}),
    };
  }

  resolve(
    scope: PortalFileReferenceScope,
    reference: PortalChatFileReference,
  ): HostPortalChatFileReference {
    this.authorize(scope);
    this.prune();
    const entry = this.entries.get(reference.referenceId);
    if (
      !entry ||
      entry.scope.sessionId !== scope.sessionId ||
      entry.scope.projectId !== scope.projectId ||
      entry.scope.worktreeId !== scope.worktreeId
    ) {
      throw this.denied();
    }
    this.authorize(entry.scope);
    return {
      ...entry.file,
      displayPath: reference.displayPath,
      ...(reference.kind !== undefined ? { kind: reference.kind } : {}),
      ...(reference.textStart !== undefined
        ? { textStart: reference.textStart }
        : {}),
    };
  }

  clearSession(sessionId: string): void {
    for (const [referenceId, entry] of Array.from(this.entries)) {
      if (entry.scope.sessionId === sessionId) this.remove(referenceId);
    }
    this.schedule();
  }

  clear(): void {
    this.entries.clear();
    this.index.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private authorize(scope: PortalFileReferenceScope): void {
    if (
      !scope.sessionId ||
      !scope.projectId ||
      !scope.worktreeId ||
      scope.canRead?.() === false
    ) {
      this.clearSession(scope.sessionId);
      throw this.denied();
    }
  }

  private denied(): PortalServiceError {
    return new PortalServiceError(
      'invalid_target',
      'The file reference is no longer authorized. Select the file again.',
    );
  }

  private remove(referenceId: string): void {
    const entry = this.entries.get(referenceId);
    if (entry) this.index.delete(entry.key);
    this.entries.delete(referenceId);
  }

  private prune(): void {
    const now = this.now();
    for (const [referenceId, entry] of Array.from(this.entries)) {
      if (entry.expiresAt <= now) this.remove(referenceId);
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.entries.size === 0) return;
    const next = Math.min(
      ...Array.from(this.entries.values(), (entry) => entry.expiresAt),
    );
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.prune();
        this.schedule();
      },
      Math.max(1, next - this.now()),
    );
    this.timer.unref();
  }
}

export const portalFileReferences = new PortalFileReferenceRegistry();
