import { randomUUID } from 'node:crypto';
import type {
  ChatCancelRequest,
  ChatResumeStoppedTurnRequest,
  ChatResumeStoppedTurnResult,
} from '@canopy/desktop-shared/types';

type ResumeOfferState =
  | 'preparing'
  | 'available'
  | 'in_progress'
  | 'dispatched';

export interface ResumeOffer {
  attemptId: string;
  userMessageId: string;
  state: ResumeOfferState;
  invalidatedByNewTurn?: boolean;
}

function targetKey(target: ChatCancelRequest): string {
  return JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
}

function displayError(): string {
  return 'Could not resume the stopped turn. Try again.';
}

/**
 * Process-local ownership for explicit stopped-turn resumes.
 *
 * Offers intentionally do not survive restart: they describe a user stop in
 * the current provider/session lifecycle. Durable transcript state remains
 * authoritative, while this coordinator prevents stale or duplicate dispatch.
 */
export class StoppedTurnResumeService {
  private readonly offers = new Map<string, ResumeOffer>();
  private readonly turnsWithUnpersistedContext = new Map<string, string>();

  public offer(target: ChatCancelRequest, userMessageId: string): void {
    const offer = this.beginOffer(target, userMessageId);
    if (offer) this.completeOffer(target, offer);
  }

  /**
   * Record whether a new root turn carries context that canonical tab metadata
   * cannot reconstruct. Resume must fail closed for that exact turn rather
   * than recreating its provider session with missing capabilities.
   */
  public recordTurnContext(
    target: ChatCancelRequest,
    userMessageId: string,
    hasUnpersistedContext: boolean,
  ): void {
    const key = targetKey(target);
    if (hasUnpersistedContext) {
      this.turnsWithUnpersistedContext.set(key, userMessageId);
      const offer = this.offers.get(key);
      if (
        offer?.userMessageId === userMessageId &&
        offer.state !== 'dispatched'
      ) {
        this.offers.delete(key);
      }
    } else {
      this.turnsWithUnpersistedContext.delete(key);
    }
  }

  public beginOffer(
    target: ChatCancelRequest,
    userMessageId: string,
  ): ResumeOffer | undefined {
    const key = targetKey(target);
    if (this.turnsWithUnpersistedContext.get(key) === userMessageId) {
      return undefined;
    }
    const offer: ResumeOffer = {
      attemptId: randomUUID(),
      userMessageId,
      state: 'preparing',
    };
    this.offers.set(key, offer);
    return offer;
  }

  public completeOffer(
    target: ChatCancelRequest,
    offer: ResumeOffer | undefined,
  ): boolean {
    if (!offer) return false;
    if (this.offers.get(targetKey(target)) !== offer) return false;
    offer.state = 'available';
    return true;
  }

  public invalidate(target: ChatCancelRequest): void {
    this.offers.delete(targetKey(target));
  }

  public invalidateForNewTurn(
    target: ChatCancelRequest,
    userMessageId: string,
  ): void {
    const key = targetKey(target);
    const offer = this.offers.get(key);
    if (
      offer &&
      offer.userMessageId !== userMessageId &&
      offer.state === 'dispatched'
    ) {
      offer.invalidatedByNewTurn = true;
    } else if (offer && offer.userMessageId !== userMessageId) {
      this.offers.delete(key);
    }
  }

  /**
   * Promote an in-progress attempt immediately before its synchronous queue
   * reservation. From this point, a newer send may hide the offer but must not
   * discard terminal-settlement ownership for the active resumed turn.
   */
  public markDispatchStarted(
    target: ChatCancelRequest,
    userMessageId: string,
    attemptId: string,
  ): boolean {
    const offer = this.offers.get(targetKey(target));
    if (
      offer?.userMessageId !== userMessageId ||
      offer.attemptId !== attemptId ||
      offer.state !== 'in_progress'
    ) {
      return false;
    }
    offer.state = 'dispatched';
    return true;
  }

  /** True while the resumed dispatch owns terminal settlement for this turn. */
  public ownsTerminalSettlement(
    target: ChatCancelRequest,
    userMessageId: string,
  ): boolean {
    const offer = this.offers.get(targetKey(target));
    return (
      offer !== undefined &&
      offer.userMessageId === userMessageId &&
      (offer.state === 'in_progress' || offer.state === 'dispatched')
    );
  }

  /** Release ownership once the resumed transport itself has settled. */
  public settleTerminalOwnership(
    target: ChatCancelRequest,
    userMessageId: string,
  ): void {
    const key = targetKey(target);
    const offer = this.offers.get(key);
    if (
      offer?.userMessageId === userMessageId &&
      (offer.state === 'in_progress' || offer.state === 'dispatched')
    ) {
      this.offers.delete(key);
    }
  }

  public async resume(
    request: Pick<
      ChatResumeStoppedTurnRequest,
      'projectId' | 'worktreeId' | 'chatId' | 'userMessageId'
    >,
    dispatch: (
      attemptId: string,
      isCurrent: () => boolean,
    ) => Promise<boolean | void>,
  ): Promise<ChatResumeStoppedTurnResult> {
    const key = targetKey(request);
    const offer = this.offers.get(key);
    if (!offer || offer.userMessageId !== request.userMessageId) {
      return { disposition: 'stale' };
    }
    if (offer.state === 'preparing' || offer.state === 'in_progress') {
      return { disposition: 'in_progress' };
    }
    if (offer.state === 'dispatched') {
      return offer.invalidatedByNewTurn
        ? { disposition: 'stale' }
        : { disposition: 'already_dispatched' };
    }

    offer.state = 'in_progress';
    try {
      const dispatched = await dispatch(
        offer.attemptId,
        () => this.offers.get(key) === offer && offer.state === 'in_progress',
      );
      if (dispatched === false) return { disposition: 'stale' };
      if (this.offers.get(key) === offer) offer.state = 'dispatched';
      return { disposition: 'dispatched' };
    } catch {
      if (this.offers.get(key) === offer) {
        if (offer.invalidatedByNewTurn) this.offers.delete(key);
        else offer.state = 'available';
      }
      return {
        disposition: 'failed',
        error: displayError(),
        retryable: true,
      };
    }
  }

  public resetForTests(): void {
    this.offers.clear();
    this.turnsWithUnpersistedContext.clear();
  }
}

const stoppedTurnResumeService = new StoppedTurnResumeService();

export function getStoppedTurnResumeService(): StoppedTurnResumeService {
  return stoppedTurnResumeService;
}
