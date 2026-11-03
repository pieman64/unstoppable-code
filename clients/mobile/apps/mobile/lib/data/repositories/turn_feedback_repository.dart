import 'dart:async';

import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/feedback_outbox_store.dart';
import 'package:mobile/data/services/turn_feedback_api_service.dart';

/// Denormalized technical context stored alongside a rating so the warehouse
/// can slice it without joining a transcript row.
///
/// [eventType] must be one of the server's closed `TELEMETRY_EVENT_TYPES`
/// values (`packages/protocol/src/telemetry/index.ts`) — the same value
/// desktop sends for the chat's scope (`'worktree_chat'` for a worktree chat,
/// `'standalone_chat'` for a cowork/standalone chat). Callers must not invent
/// a mobile-specific value; the server silently drops anything it does not
/// recognize.
final class TurnFeedbackContext {
  const TurnFeedbackContext({
    this.provider,
    this.model,
    this.chatMode,
    this.appVersion,
    this.eventType,
  });

  final String? provider;
  final String? model;
  final String? chatMode;
  final String? appVersion;
  final String? eventType;
}

/// Outcome of a write — a rating, a detail, or a retraction. All three report
/// the same shape so a caller that applied an optimistic change can decide
/// whether to keep it on exactly the same rule.
///
/// `synced: false` on its own means the operation is durably QUEUED, not that
/// it was lost — the caller keeps the rating selected, because the write will
/// still land. [dropped] is the other half of that story: the write was
/// refused outright (a 400/403/404/409/413, or an undecodable success body —
/// see [shouldQueueTurnFeedbackFailure]) or there was no signed-in account to
/// attribute a queued entry to. Nothing is stored anywhere and nothing will
/// ever retry it, so a caller that keeps its optimistic selection would be
/// showing a thumb that misreports what happened.
final class TurnFeedbackWriteResult {
  const TurnFeedbackWriteResult({
    required this.synced,
    this.feedbackId,
    this.dropped = false,
  });

  final bool synced;
  final String? feedbackId;

  /// Only meaningful when [synced] is false. Defaults to false so the common
  /// "failed but durably queued" outcome stays the unannotated one.
  final bool dropped;
}

/// One rating that reached the server for the first time during a
/// [TurnFeedbackRepository.flushOutbox] replay, and the `feedbackId` the
/// server answered with.
///
/// This exists because the replay is the ONLY path that obtains a feedbackId
/// and had no way to hand it back. A rating queued while offline is created
/// server-side here, not in [TurnFeedbackRepository.rate], so without this the
/// caller's entry keeps `feedbackId: null` for the rest of the session — and
/// a later retraction takes `clear`'s "there is nothing on the server to
/// retract" branch, which the replay has just falsified. Only a `rate` learns
/// an id: a replayed `clear` removes the row, and a replayed `detail` patches
/// one whose id the caller already had.
final class TurnFeedbackReplayedRating {
  const TurnFeedbackReplayedRating({
    required this.clientChatId,
    required this.clientUserMessageId,
    required this.feedbackId,
  });

  final String clientChatId;
  final String clientUserMessageId;
  final String feedbackId;
}

/// Raised when the signed-in account changed between a write being opened and
/// its request reaching the wire. Deliberately neither an [ApiException] nor a
/// [FormatException], so [shouldQueueTurnFeedbackFailure] treats it as the
/// ordinary retryable failure it is: the write is durably queued under the
/// account that authored it and replays when THAT account is signed in.
final class TurnFeedbackAccountChanged implements Exception {
  const TurnFeedbackAccountChanged();

  @override
  String toString() =>
      'TurnFeedbackAccountChanged: the signed-in account changed before the '
      'request was sent';
}

/// Whether a failed write is worth retrying later.
///
/// A 400/403/404/409/413 will fail identically on every retry: queueing it
/// burns an outbox slot forever and hides the real problem. A 401 IS retried —
/// the session may simply have expired and be restored on the next sign-in.
/// That is safe only because every queued entry carries the account that
/// authored it (`FeedbackOutboxEntry.accountId`) and [flushOutbox] sends none
/// but the current account's: a 401-queued rating waits for ITS OWN account to
/// come back rather than going out under whoever signs in next.
bool shouldQueueTurnFeedbackFailure(Object error) {
  // A decode failure is not a transport failure. `ApiClient` only reaches
  // `jsonDecode` (and `TurnFeedbackSummary.fromJson` only runs) on a 2xx, so a
  // [FormatException] means the request REACHED the server and the server
  // ACCEPTED it — the write already landed and only the response body was
  // unreadable. Retrying re-sends a write that succeeded, and since the same
  // body decodes identically every time the entry would never leave the queue.
  if (error is FormatException) return false;
  if (error is! ApiException) return true;
  final status = error.statusCode;
  if (status == 401 || status == 408 || status == 429) return true;
  return status >= 500;
}

abstract interface class TurnFeedbackRepository {
  Future<List<TurnFeedbackSummary>> listForChat(String clientChatId);

  Future<TurnFeedbackWriteResult> rate({
    required String clientUserMessageId,
    required String clientChatId,
    required TurnFeedbackRating rating,
    // `required`, not defaulted: a non-nullable optional named parameter with
    // no default does not compile, and the interface must not carry the
    // implementations' default. The controller supplies its own default.
    required TurnFeedbackContext context,
  });

  Future<TurnFeedbackWriteResult> attachDetail({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
    TurnFeedbackReason? reason,
    String? comment,
  });

  Future<TurnFeedbackWriteResult> clear({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
  });

  /// Replays everything the durable outbox still owes the server, and
  /// reports the ratings that learned a [TurnFeedbackReplayedRating.feedbackId]
  /// on the way out. See that type for why the id has to come back.
  Future<List<TurnFeedbackReplayedRating>> flushOutbox();
}

/// One turn's supersession watermark: the newest sequence that has settled
/// FOR EACH KIND, not one pair for the turn as a whole.
///
/// Per-kind because a single `(seq, supersedes)` pair cannot express the
/// state a real session reaches. A `detail` PATCH that succeeds supersedes
/// only `detail`; a `rate` or `clear` that succeeds supersedes everything.
/// Recording the latest of those wholesale lets a narrow write NARROW the
/// watermark, un-superseding the older in-flight writes a previous broad
/// write had already ruled out — so a hung DELETE that fails after a
/// successful rating and a successful detail is allowed back into the queue
/// and wipes both.
///
/// Raising each kind independently to `max(existing, seq)` is also why the
/// kinds are not simply unioned at the highest sequence: a `rate` that
/// STARTED between two settles must still be judged against the sequence
/// that actually superseded its kind, not against a later, narrower write's.
typedef _KindWatermark = Map<FeedbackOutboxKind, int>;

/// The networked repository, and the home of the one ordering rule every
/// outbox mutation here obeys.
///
/// Three review rounds each found the same defect wearing a different hat: an
/// ordering discipline applied to some paths and not others (a success-path
/// removal that was bounded in `rate` but not `clear`, then not `attachDetail`;
/// then bounded on removals but not on insertions; then absent from the replay
/// loop). The rule is therefore stated once, here, and enforced structurally
/// rather than restated at each call site:
///
/// **Every write against one turn opens a [_TurnWrite] first, every outbox
/// insertion and removal for that turn happens through it, and every path
/// that reaches a definite outcome publishes what it superseded — per kind,
/// at its own sequence — before anything older is allowed to act.**
///
/// A [_TurnWrite] captures two things the moment the write begins — the
/// account it is attributed to, and a monotonic sequence marking where it sits
/// among all local writes — and exposes exactly two terminal operations:
///
/// - [_TurnWrite.settle] on a definite outcome: publishes this write into the
///   turn's [_KindWatermark] and sweeps the entries it superseded.
/// - [_TurnWrite.queue] on a retryable failure: stores an entry, UNLESS the
///   watermark says a newer write has already superseded its kind.
///
/// Both read the same `supersedes` kind set and the same sequence, so a
/// removal and an insertion can never disagree about what supersedes what. A
/// fourth verb cannot skip the rule by accident: [FeedbackOutboxEntry.seq] is
/// required, the only source of sequences is [_nextSeq], and it is only
/// reachable from inside [_TurnWrite]. Code that does not open a write has
/// nothing to stamp an entry with.
///
/// The watermark is PER KIND ([_KindWatermark]) precisely so publishing is
/// monotonic: settling can only ever raise a kind's sequence, so no outcome
/// can narrow the turn's state and re-admit writes an earlier, broader
/// outcome had already ruled out.
///
/// [flushOutbox] is the replay loop rather than a verb, and is held to both
/// halves of the rule rather than only the reading half: it re-checks the
/// account on every iteration, skips any entry a newer settled write has
/// superseded, PUBLISHES the same watermark the equivalent online verb
/// publishes for every entry it successfully sends (at that entry's own
/// sequence), and removes only the exact entries it itself sent. It is also
/// the path that CREATES a rating server-side for a device that was offline,
/// so it reports back the [TurnFeedbackReplayedRating] ids it learned — the
/// caller's entry has no other way to find out, and cannot retract a rating
/// whose id it never saw.
///
/// A second rule cuts the other way across the same paths, as two nested
/// chokepoints: **every request goes through [_bounded]**, which applies the
/// one liveness rule they all share, and **every WRITE goes through [_send]**,
/// which adds the account re-check that applies to writes only. Both concerns
/// were previously spelled at each call site, and both were missing somewhere —
/// the timeout from the replay loop and the hydration read, the account check
/// from every verb. Neither is optional now, and the split is what lets the
/// read acquire the rule that applies to it without acquiring one that does
/// not.
///
/// One more rule cuts across all of it: **a failing outbox store costs
/// durability, never the write.** Every store touch here — the read that
/// issues a sequence, the settle sweep, the queue insert, and the replay
/// read/removal — degrades to "not stored" rather than throwing. These calls
/// sit under `unawaited(...)` lifecycle or UI paths, so an escaping store error
/// is an unhandled zone error instead of an honest best-effort outcome.
///
/// That rule used to hold only for a store that FAILS. A store that simply
/// never answers had no bound at all, and the store leg is where the widest
/// blast radius lives: [_serialized]'s chain is process-wide, and [_runWrite]
/// awaits it BEFORE the network call. One stalled `SharedPreferences` read
/// therefore parked every turn's rating (the row disables both thumbs while
/// `pending`), the detail sheet (whose controls disable while its submit is in
/// flight, leaving the modal barrier as the only exit and destroying the typed
/// comment), and [flushOutbox] (`_flushing` never cleared) for the process
/// lifetime — with a perfectly healthy server. [storeTimeout] is what turns
/// "never answers" into the ordinary store failure the rule above already
/// covers.
final class HttpTurnFeedbackRepository implements TurnFeedbackRepository {
  HttpTurnFeedbackRepository({
    required this.service,
    required this.outbox,
    required this.accountId,
    this.now = DateTime.now,
    this.requestTimeout = const Duration(seconds: 30),
    this.storeTimeout = const Duration(seconds: 5),
  });

  final TurnFeedbackApiService service;
  final FeedbackOutboxStore outbox;

  /// The signed-in account's stable user id, or null while signed out.
  ///
  /// Read live on every call rather than captured once: this repository is an
  /// app-lifetime singleton (see `_buildTurnFeedbackRepository` in
  /// `main.dart`) that outlives any individual session, so a value frozen at
  /// construction would be the wrong account for every session after the
  /// first. Every queued entry is stamped with it, and [flushOutbox] refuses
  /// to send anything that is not stamped with the CURRENT one — see
  /// `FeedbackOutboxEntry.accountId`.
  final String? Function() accountId;

  /// Injectable WALL clock. Its only jobs are stamping
  /// [FeedbackOutboxEntry.queuedAtMs] and supplying `nowMs` to the 14-day
  /// prune — both genuinely about calendar age. Nothing in this class orders
  /// two local writes with it; that is [_nextSeq]'s job. See
  /// [FeedbackOutboxEntry.seq].
  final DateTime Function() now;

  /// How long ONE turn-feedback request may stay open before it is abandoned.
  ///
  /// **Every** network call this repository makes is bounded by it — the three
  /// verbs, the four replay requests, and the hydration read — because
  /// `ApiClient` sets no timeout of its own and a socket that accepts a request
  /// and never answers is a permanent local failure otherwise. It is one bound
  /// for the class rather than a per-path budget on purpose: what each path
  /// loses to a hung socket differs, but the thing being bounded is the same
  /// stuck connection.
  ///
  /// What expiry costs, per path — in every case the request is abandoned and
  /// handled as an ordinary retryable failure, exactly as a dropped connection
  /// would be:
  ///
  /// - A **verb** parks its turn's write slot ([_runWrite]'s per-turn chain)
  ///   and every later tap on that turn waits behind it. On expiry the write is
  ///   durably queued and replays on the next flush.
  /// - A **replay** parks the whole outbox: `_flushing` is cleared only in the
  ///   `finally` of a [flushOutbox] that never returns, so both flush triggers
  ///   (resume and sign-in) stay disabled for the process lifetime. On expiry
  ///   the entry stays queued and the flush moves on.
  /// - A **read** ([listForChat]) fails on expiry so its caller can retry.
  ///
  /// The 30-second default is CHOSEN, not measured: it is a liveness bound on
  /// a stuck connection, not a latency budget. It does not cancel the request
  /// server-side; a write the server did accept is simply re-sent, which these
  /// endpoints upsert idempotently on `(userId, clientUserMessageId)`.
  final Duration requestTimeout;

  /// How long ONE outbox store touch — a read or a write — may stay open.
  ///
  /// [requestTimeout]'s counterpart for the OTHER leg, and it is the leg with
  /// the wider blast radius. Bounding only the network left three unbounded
  /// awaits in front of every request: [_serialized]'s process-wide chain,
  /// `outbox.read()`, and the `SharedPreferences` platform channel beneath it.
  /// [_runWrite] awaits that chain BEFORE opening its request, so a store that
  /// stalls is not a slow save — it is every rating, every retraction, the
  /// thumbs-down detail sheet, and every future [flushOutbox] wedged for the
  /// process lifetime, with the network never touched.
  ///
  /// Bounding it here rather than around [_serialized] is deliberate: a
  /// timeout on the chain's RESULT would unblock one caller while the chain
  /// itself stayed stuck behind the stalled action, so the next caller would
  /// wedge again. Bounding the store call means the chain link itself
  /// completes, and the expiry arrives as an ordinary store error at the
  /// catch sites that already implement the degradation rule above:
  /// [flushOutbox]'s initial read and its handled-entry removal,
  /// [_runWrite]'s seq-issuing read, [_pruneAndReadLocked]'s prune write,
  /// [_TurnWrite.settle]'s sweep, and [_TurnWrite.queue]'s read and insert.
  /// Named rather than counted on purpose: this comment has now been stale
  /// three times, each time in text written by the round that was fixing the
  /// previous stale count.
  ///
  /// What expiry costs, and why that is the right direction: `.timeout` does
  /// not cancel the underlying write, so a queue insert reported as `dropped`
  /// may still reach disk and replay later — the user is told less than
  /// actually happened. That is the same conservative direction [_bounded]
  /// takes with a request the server may have accepted, and it is strictly
  /// better than the alternative it replaces, which was reporting nothing at
  /// all, forever.
  ///
  /// 5 seconds is CHOSEN, not measured: a local key-value read that has not
  /// answered in five seconds is not slow, it is stuck.
  final Duration storeTimeout;

  /// Serializes every outbox store read-modify-write against every other
  /// one, WITHOUT holding a lock across network I/O. A naive
  /// read-await(network)-write shape (the original bug here) can clobber an
  /// entry queued by a concurrent call while the network call was in
  /// flight. Every closure passed to [_serialized] must be store access
  /// only — awaiting a network call inside one would block unrelated
  /// rating/clear writes for its whole duration.
  Future<void> _queueChain = Future<void>.value();

  /// The tail of each `(account, turn)`'s write chain — the future a new write
  /// against that turn waits on before it opens its request. See [_runWrite].
  ///
  /// Holds only the writes actually in flight or waiting: the last write on a
  /// key removes it, so this cannot grow with the number of turns rated.
  final Map<(String?, String), Future<void>> _turnWrites =
      <(String?, String), Future<void>>{};

  /// Reentrancy guard: a second overlapping [flushOutbox] call (Task 12
  /// flushes on every app resume) must not double-send whatever the first
  /// call is still mid-network on.
  bool _flushing = false;

  /// The monotonic ordering counter behind [FeedbackOutboxEntry.seq].
  ///
  /// Only ever incremented, and always raised past every sequence read out of
  /// the store first (see [_readLocked]) so it stays monotonic across app
  /// restarts, when this field starts back at zero but the persisted queue
  /// does not.
  int _seq = 0;

  /// The supersession watermark per `(account, turn)` — what an older write
  /// consults before it is allowed to queue anything, and what a replayed
  /// entry is checked against before it is sent. See [_KindWatermark].
  ///
  /// Bounded: a per-turn map on an app-lifetime singleton would otherwise
  /// grow for every turn the user ever rates. Eviction costs an evicted turn
  /// its supersession guard, which is the pre-existing behavior, and the
  /// least-recently-settled turn is the one least likely to still have a
  /// request in flight against it.
  final Map<(String?, String), _KindWatermark> _settled =
      <(String?, String), _KindWatermark>{};

  /// Server ids learned by replayed POSTs before the surrounding flush has
  /// finished. A replay may spend another request timeout attaching detail;
  /// during that window a retraction must still be able to address the row.
  final Map<(String?, String), String> _replayedFeedbackIds =
      <(String?, String), String>{};

  /// The bound on [_settled]. Public because the test that pins the eviction
  /// cost has to settle MORE than this many turns to observe it; hard-coding a
  /// number there would silently turn that test into a no-op the moment the
  /// capacity grew.
  static const int settledWatermarkCapacity = 500;

  Future<T> _serialized<T>(Future<T> Function() action) {
    final result = _queueChain.then((_) => action());
    // Keep the chain alive even if `action` throws, so a failed critical
    // section doesn't wedge every later one. The caller still observes the
    // real outcome through `result`.
    _queueChain = result.then((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  /// The ONE way ANY request in this class reaches the wire — the three verbs,
  /// the four replay requests, and the hydration read.
  ///
  /// It carries the rule that applies to all of them and only that rule: the
  /// request is bounded by [requestTimeout]. `ApiClient` sets none of its own,
  /// so an unbounded call here is a permanent local failure — see
  /// [requestTimeout] for what each path loses.
  ///
  /// Deliberately SPLIT from [_send] rather than fused with it — for INTENT,
  /// not because fusing would misbehave.
  ///
  /// Be precise about this, because an earlier version of this comment was not.
  /// The fused form is `_send(accountId(), request)`, and it would compile and
  /// pass the entire suite: [_send] compares `accountId() != account`
  /// SYNCHRONOUSLY, before any await, so passing `accountId()` as `account`
  /// compares a value against itself and the guard is provably inert. Anyone
  /// mutation-testing this split will find the fusion survives — that is an
  /// EQUIVALENT MUTANT, not a gap in coverage, and not evidence that the split
  /// is load-bearing.
  ///
  /// The split earns its place anyway: it keeps a read from carrying a guard
  /// that READS as protection while providing none. A reader who saw the read
  /// go through [_send] would reasonably conclude that reads are account-checked
  /// like writes; they are not, and they do not need to be — a read carries no
  /// captured account to compare against, cannot write under the wrong bearer,
  /// so callers must discard results when their account changes. Two functions,
  /// one nested in the other, let every request acquire its timeout without
  /// implying that reads carry the write's account guard.
  Future<T> _bounded<T>(Future<T> Function() request) =>
      request().timeout(requestTimeout);

  /// The ONE way this class reads the store, and the ONE way it writes it.
  /// Both carry [storeTimeout] for the same reason [_bounded] carries
  /// [requestTimeout]: an unbounded local touch is a permanent wedge, not a
  /// slow one. Call sites keep their existing `try`/`catch` — a
  /// [TimeoutException] is just another store failure to them.
  Future<List<FeedbackOutboxEntry>> _readStore() =>
      outbox.read().timeout(storeTimeout);

  Future<void> _writeStore(List<FeedbackOutboxEntry> entries) =>
      outbox.write(entries).timeout(storeTimeout);

  /// The ONE way a turn-feedback WRITE reaches the wire, verb and replay alike:
  /// [_bounded], plus the rule that applies to writes only.
  ///
  /// **The account is re-checked immediately before the request opens.**
  /// [_runWrite] reads `accountId()` on its synchronous path, but the request
  /// does not go out until the turn's predecessor releases the slot — up to
  /// [requestTimeout] later, a window serialization widened from microseconds
  /// to tens of seconds. `service.*` builds its headers from the LIVE session,
  /// and the server upserts on `(userId, clientUserMessageId)` with no
  /// ownership check, so a write stamped under one account could be sent as
  /// another. A mismatch is an ordinary retryable failure
  /// ([TurnFeedbackAccountChanged]): the write is queued under the account that
  /// authored it and waits for that account to come back, exactly as a 401
  /// does.
  Future<T> _send<T>(String? account, Future<T> Function() request) {
    if (accountId() != account) {
      return Future<T>.error(const TurnFeedbackAccountChanged());
    }
    return _bounded(request);
  }

  /// Bounded by [requestTimeout] like every other request, but NOT routed
  /// through [_send]: a read has no captured account to re-check.
  @override
  Future<List<TurnFeedbackSummary>> listForChat(String clientChatId) =>
      _bounded(() => service.listForChat(clientChatId));

  @override
  Future<TurnFeedbackWriteResult> rate({
    required String clientUserMessageId,
    required String clientChatId,
    required TurnFeedbackRating rating,
    required TurnFeedbackContext context,
  }) => _runWrite<TurnFeedbackWriteResult>(clientUserMessageId, (write) async {
    // The write was opened BEFORE the request goes out: that is what places it
    // among all the others against this turn — for the sweep below, for the
    // supersession check on the failure path, and for the serialization that
    // stops a second tap racing this one.
    final TurnFeedbackSummary summary;
    try {
      summary = await _send(
        write.account,
        () => service.rate(
          clientUserMessageId: clientUserMessageId,
          clientChatId: clientChatId,
          rating: rating,
          provider: context.provider,
          model: context.model,
          chatMode: context.chatMode,
          appVersion: context.appVersion,
          eventType: context.eventType,
        ),
      );
    } catch (error) {
      // Parsing happens only after a 2xx response, so a FormatException means
      // the server accepted the POST but this client could not recover its id.
      // Keep the optimistic thumb and queue an idempotent replay that can
      // reconcile the id instead of reporting the accepted rating as dropped.
      final acceptedButUnconfirmed = error is FormatException;
      var queued = false;
      if (acceptedButUnconfirmed || shouldQueueTurnFeedbackFailure(error)) {
        // [_TurnWrite.queue] refuses when there is no account to attribute
        // the entry to (an unscoped entry could only ever replay under
        // whoever signs in next), and when a newer write for this turn has
        // already settled — a rating that lost the race, or one the user has
        // since retracted, must not come back through the queue.
        queued = await write.queue(
          FeedbackOutboxKind.rate,
          (entries, seq, _) => FeedbackOutboxEntry(
            kind: FeedbackOutboxKind.rate,
            clientUserMessageId: clientUserMessageId,
            clientChatId: clientChatId,
            accountId: write.account,
            rating: rating,
            provider: context.provider,
            model: context.model,
            chatMode: context.chatMode,
            appVersion: context.appVersion,
            eventType: context.eventType,
            queuedAtMs: now().millisecondsSinceEpoch,
            seq: seq,
          ),
        );
      }
      // Ordinarily `dropped` means nothing was stored and no retry will happen.
      // The accepted-but-unconfirmed case is different: server truth already
      // includes the rating, so the optimistic selection remains honest even if
      // the best-effort reconciliation entry could not be persisted.
      return TurnFeedbackWriteResult(
        synced: false,
        dropped: acceptedButUnconfirmed ? false : !queued,
      );
    }
    // Deliberately OUTSIDE the try: this rating is now the server's truth for
    // the turn, so anything THIS ACCOUNT had queued for it BEFORE this write
    // began is stale by definition. Without the sweep, an offline thumbs-down
    // followed by an online thumbs-up is reverted the next time the outbox
    // flushes the queued `down`. Entries queued while this POST was in flight
    // are NEWER than what the server just accepted and survive; another
    // account's entry for the same turn is never touched. A store failure
    // here must not be mistaken for a failed write and re-queue the rating.
    await write.settle();
    _rememberFeedbackId(write.account, clientUserMessageId, summary.feedbackId);
    return TurnFeedbackWriteResult(
      synced: true,
      feedbackId: summary.feedbackId,
    );
  });

  @override
  Future<TurnFeedbackWriteResult> attachDetail({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
    TurnFeedbackReason? reason,
    String? comment,
  }) => _runWrite<TurnFeedbackWriteResult>(clientUserMessageId, (write) async {
    if (feedbackId != null) {
      var patched = false;
      try {
        await _send(
          write.account,
          () => service.attachDetail(
            feedbackId: feedbackId,
            reason: reason,
            comment: comment,
          ),
        );
        patched = true;
      } catch (error) {
        // Refused outright: nothing is queued and nothing will retry, so the
        // caller must not go on rendering the reason it applied optimistically.
        if (!shouldQueueTurnFeedbackFailure(error)) {
          return const TurnFeedbackWriteResult(synced: false, dropped: true);
        }
      }
      if (patched) {
        // Narrowed to `detail`, unlike `rate` and `clear`: a queued `rate` is
        // a NEWER rating the server has still never seen (this PATCH landed
        // against the previous feedback row), and a queued `clear` is a
        // retraction it has not seen either. Sweeping either would lose the
        // user's choice. The same narrowing is published as this write's
        // watermark, so a `detail` that fails later is refused while a `rate`
        // that fails later is still allowed to queue.
        await write.settle(
          supersedes: const <FeedbackOutboxKind>{FeedbackOutboxKind.detail},
        );
        return const TurnFeedbackWriteResult(synced: true);
      }
    }
    // Either the rating has not synced yet (no feedbackId) or the PATCH
    // above failed retryably: merge into whatever is already queued for
    // this turn rather than inserting a standalone `detail` entry that
    // could clobber it — see [_buildQueuedDetail]'s doc comment for the rules.
    final queued = await write.queue(
      FeedbackOutboxKind.detail,
      (entries, seq, nextSeq) => _buildQueuedDetail(
        entries: entries,
        seq: seq,
        nextSeq: nextSeq,
        account: write.account,
        clientUserMessageId: clientUserMessageId,
        clientChatId: clientChatId,
        feedbackId: feedbackId,
        reason: reason,
        comment: comment,
      ),
    );
    // Nothing stored (no account, nothing to attach to, a pending clear that
    // supersedes the detail, or a newer settled write for this turn) means
    // nothing will ever retry it.
    return TurnFeedbackWriteResult(synced: false, dropped: !queued);
  });

  @override
  Future<TurnFeedbackWriteResult> clear({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
  }) => _runWrite<TurnFeedbackWriteResult>(clientUserMessageId, (write) async {
    final resolvedFeedbackId =
        feedbackId ??
        _replayedFeedbackIds[(write.account, clientUserMessageId)];
    if (resolvedFeedbackId == null) {
      // Nothing on the server to retract. Dropping a still-pending `rate` IS
      // the clear; a pending `detail` describes a rating that will not exist
      // and goes with it; a pending `clear` is itself a retraction the server
      // has not received yet and must survive.
      //
      // The watermark is published even when there was nothing to remove.
      // That empty case is the retraction-versus-in-flight-rating hazard: the
      // user taps a thumb, the POST hangs, they tap again to retract, and
      // there is neither a feedbackId nor a queued entry to act on — so
      // without this the hung POST fails, queues, and the next flush records
      // a rating the user explicitly took back.
      final swept = await write.settle(
        supersedes: const <FeedbackOutboxKind>{
          FeedbackOutboxKind.rate,
          FeedbackOutboxKind.detail,
        },
      );
      final droppedPendingRate = swept.any(
        (entry) => entry.kind == FeedbackOutboxKind.rate,
      );
      // A dropped pending rate means the retraction is fully applied. With
      // nothing to remove, nothing was sent and nothing was refused — NOT
      // `dropped`, since the caller's optimistic de-selection still matches
      // reality.
      return TurnFeedbackWriteResult(synced: droppedPendingRate);
    }

    try {
      await _send(write.account, () => service.clear(resolvedFeedbackId));
      // Every kind: the retraction is the turn's newest truth, so a queued
      // rating, detail or earlier retraction from before this DELETE began is
      // all equally stale.
      await write.settle();
      _replayedFeedbackIds.remove((write.account, clientUserMessageId));
      return const TurnFeedbackWriteResult(synced: true);
    } catch (error) {
      var queued = false;
      if (shouldQueueTurnFeedbackFailure(error)) {
        queued = await write.queue(
          FeedbackOutboxKind.clear,
          (entries, seq, _) => FeedbackOutboxEntry(
            kind: FeedbackOutboxKind.clear,
            clientUserMessageId: clientUserMessageId,
            clientChatId: clientChatId,
            accountId: write.account,
            feedbackId: resolvedFeedbackId,
            queuedAtMs: now().millisecondsSinceEpoch,
            seq: seq,
          ),
        );
      }
      // A retraction refused outright (400/403/404) leaves the rating on the
      // server with nothing queued to remove it, so the caller must restore
      // the thumb rather than show a turn as unrated. Nothing was swept on
      // this path either: a pending `rate` this DELETE never superseded stays
      // queued, so the restored thumb and the queue still agree.
      return TurnFeedbackWriteResult(synced: false, dropped: !queued);
    }
  });

  @override
  Future<List<TurnFeedbackReplayedRating>> flushOutbox() async {
    // Every early return answers with the same empty list rather than null:
    // "nothing replayed" is one outcome, not several.
    final replayed = <TurnFeedbackReplayedRating>[];
    // Signed out: there is no session to send under, and the queue's entries
    // belong to accounts that are not currently signed in. Sending them now
    // would attribute them to whoever signs in next.
    final account = accountId();
    if (account == null) return replayed;
    if (_flushing) return replayed;
    _flushing = true;
    try {
      final List<FeedbackOutboxEntry> all;
      try {
        all = await _serialized(_pruneAndReadLocked);
      } on Object catch (_) {
        // Replaying is best-effort background work. A broken store means
        // there is nothing safe to read or send, but must not escape the
        // unawaited lifecycle call that started this flush.
        return replayed;
      }
      // Only the signed-in account's own entries. Everyone else's stay
      // queued, untouched, for when THEY sign back in.
      final snapshot = all
          .where((entry) => entry.accountId == account)
          .toList(growable: false);
      if (snapshot.isEmpty) return replayed;

      // Network I/O happens OUTSIDE the lock: a store-only critical section
      // must never hold up a concurrent rate()/clear() write.
      final handled = <(String?, String, int)>{};
      for (final entry in snapshot) {
        // Stop the loop the moment the signed-in account changes: a sign-out
        // and sign-in partway through a multi-entry flush must not send the
        // rest of account A's ratings — and their typed comments — under
        // account B's bearer, which the server upserts on
        // `(userId, clientUserMessageId)` with no ownership check. Breaking
        // leaves the unsent entries queued for their own account.
        //
        // This is the FAST PATH, not the enforcement. [_send] re-checks the
        // same thing immediately before each request, so removing this line
        // would cost iterations rather than correctness — which is the point
        // of having the check at the chokepoint instead of only here, where
        // it used to be the sole copy and the verbs had none.
        if (accountId() != account) break;
        // A write that settled while this flush was mid-network may have
        // superseded this entry; the snapshot cannot know that. Skipping
        // leaves it out of `handled` too, so the settle's own sweep is what
        // removes it.
        if (_isSuperseded(
          entry.accountId,
          entry.clientUserMessageId,
          entry.seq,
          entry.kind,
        )) {
          continue;
        }
        try {
          if (entry.kind == FeedbackOutboxKind.clear) {
            final id = entry.feedbackId;
            if (id != null) {
              await _send(account, () => service.clear(id));
              // The same watermark `clear`'s own success path publishes, at
              // this entry's own sequence: a replay IS that write finally
              // landing, so it must rule out everything older exactly as the
              // online verb would have. Without this, the replay is the one
              // definite-outcome path in the class that READS the watermark
              // and never WRITES it — and an older in-flight write that fails
              // afterwards queues against an empty record and undoes it.
              _recordSettled(
                entry.accountId,
                entry.clientUserMessageId,
                entry.seq,
                null,
              );
            }
          } else if (entry.kind == FeedbackOutboxKind.detail) {
            final id = entry.feedbackId;
            if (id != null) {
              await _send(
                account,
                () => service.attachDetail(
                  feedbackId: id,
                  reason: entry.reason,
                  comment: entry.comment,
                ),
              );
              // Narrowed to `detail`, exactly as `attachDetail`'s own success
              // path narrows it: a queued `rate` or `clear` is a choice the
              // server has still never seen.
              _recordSettled(
                entry.accountId,
                entry.clientUserMessageId,
                entry.seq,
                const <FeedbackOutboxKind>{FeedbackOutboxKind.detail},
              );
            }
          } else if (entry.kind == FeedbackOutboxKind.rate) {
            final rating = entry.rating;
            if (rating != null) {
              final summary = await _send(
                account,
                () => service.rate(
                  clientUserMessageId: entry.clientUserMessageId,
                  clientChatId: entry.clientChatId,
                  rating: rating,
                  provider: entry.provider,
                  model: entry.model,
                  chatMode: entry.chatMode,
                  appVersion: entry.appVersion,
                  eventType: entry.eventType,
                ),
              );
              // Published as soon as the POST lands, before the optional
              // detail PATCH — the same point `rate` publishes. A PATCH
              // failure that leaves this entry queued for another flush then
              // still cannot un-supersede what the rating just superseded,
              // and the entry is not superseded out of its own retry because
              // [_isSuperseded] compares strictly greater.
              _recordSettled(
                entry.accountId,
                entry.clientUserMessageId,
                entry.seq,
                null,
              );
              // Reported as soon as the POST lands, for the same reason the
              // watermark is: this id is the server's row for the turn
              // whether or not the optional PATCH below succeeds, and a
              // caller that never learns it can never retract the rating.
              replayed.add(
                TurnFeedbackReplayedRating(
                  clientChatId: entry.clientChatId,
                  clientUserMessageId: entry.clientUserMessageId,
                  feedbackId: summary.feedbackId,
                ),
              );
              _rememberFeedbackId(
                entry.accountId,
                entry.clientUserMessageId,
                summary.feedbackId,
              );
              if (entry.reason != null || entry.comment != null) {
                await _send(
                  account,
                  () => service.attachDetail(
                    feedbackId: summary.feedbackId,
                    reason: entry.reason,
                    comment: entry.comment,
                  ),
                );
              }
            }
          }
          // Outside each kind's payload guard ON PURPOSE. A persisted entry
          // that cannot be sent at all — a `rate` with no rating, or a
          // `clear`/`detail` with no `feedbackId` — falls through every branch
          // above having sent nothing, and is then removed from the outbox.
          // That is the right outcome: an unsendable row would otherwise be
          // retried on every flush forever. It is reachable only from OUTSIDE
          // this class's own writes, which always populate the field their
          // kind needs, but `FeedbackOutboxEntry.fromJson` tolerates the shape
          // and the version guard only checks `version == 3` — so a
          // hand-edited or foreign payload can produce one. Consuming it
          // silently is deliberate, in the same spirit as `queue()`'s refusals:
          // nothing is claimed to have been sent.
          handled.add((entry.accountId, entry.clientUserMessageId, entry.seq));
        } catch (error) {
          // A retryable failure stays queued; a deliberate rejection is
          // dropped here too, matching every other write path in this
          // class.
          if (!shouldQueueTurnFeedbackFailure(error)) {
            handled.add((
              entry.accountId,
              entry.clientUserMessageId,
              entry.seq,
            ));
          }
        }
      }

      // Re-read the CURRENT store (not the snapshot) and remove only the
      // exact (account, id, seq) triples this run handled. An entry queued OR
      // MERGED INTO mid-flush for the same turn carries a fresh sequence (see
      // [_buildQueuedDetail]) and so is left untouched instead of being
      // clobbered by a stale snapshot write.
      try {
        await _serialized(() => _removeHandledLocked(handled));
      } on Object catch (_) {
        // The requests already reached the server. Leaving their entries in
        // the store costs an idempotent replay; throwing would surface as an
        // unhandled zone error from the background lifecycle hook.
        //
        // "An idempotent replay" is the ONE-OFF reading. On a store that is
        // permanently unwritable the removal never lands, so every resume and
        // every sign-in re-sends this entire queue until each entry ages out
        // at [feedbackOutboxMaxAge]. That is bounded and harmless — the
        // endpoints upsert on `(userId, clientUserMessageId)` — but it is
        // repeated work, not a single retry.
      }
    } finally {
      _flushing = false;
    }
    return replayed;
  }

  void _rememberFeedbackId(
    String? account,
    String clientUserMessageId,
    String feedbackId,
  ) {
    final key = (account, clientUserMessageId);
    // Reinsert to keep insertion order aligned with recency for eviction.
    _replayedFeedbackIds.remove(key);
    _replayedFeedbackIds[key] = feedbackId;
    if (_replayedFeedbackIds.length > settledWatermarkCapacity) {
      _replayedFeedbackIds.remove(_replayedFeedbackIds.keys.first);
    }
  }

  /// Runs [body] as this turn's next write, one at a time, and is the ONLY
  /// place a [_TurnWrite] is constructed.
  ///
  /// Two things at once, deliberately fused so neither can be had without the
  /// other:
  ///
  /// **1. At most one in-flight network write per `(account, turn)`.** Every
  /// ordering defect this class has had needed two concurrent writes against
  /// one turn, and the UI hands them out for free — `TurnFeedbackRow`
  /// dispatches `unawaited(onPressed())`, so an ordinary double-tap issues
  /// two. A write for a turn that already has one in flight waits for it and
  /// then runs; the writes are ordered, not dropped, and the LAST one the user
  /// asked for is the one that ends up in the store, because it runs last.
  /// A disabled button is not the mechanism: the sheet's detail submission and
  /// its dismissal-driven retraction are programmatic and never touch a
  /// button's `onPressed`.
  ///
  /// Nothing about the optimistic UI waits on this. `TurnFeedbackController`
  /// applies its local state change and notifies BEFORE it awaits the
  /// repository, and its `_isLatestToken` rule already keeps the newer write's
  /// state on screen while the older one drains.
  ///
  /// **2. The sequence that places the write in the total order.** Issued
  /// INSIDE the store serialization chain, after a read has raised the counter
  /// past everything already persisted, so it is strictly greater than every
  /// entry queued before this moment and strictly less than every entry queued
  /// after it — and, because the turn's writes are now serialized, strictly
  /// greater than the sequence of every earlier write against this same turn.
  ///
  /// A store that cannot be read still yields a write. This runs BEFORE the
  /// network call on every rating, from `unawaited(onPressed())`, so letting a
  /// read failure escape aborts the request entirely and strands the thumb in
  /// `pending` as an unhandled zone error. What that degradation costs is
  /// [_TurnWrite.seqTrusted], and an earlier version of this comment got it
  /// exactly backwards by calling it "durability, not the write".
  ///
  /// [_readLocked] is the ONLY thing that raises [_seq] past the persisted
  /// queue. When it does not run, the sequence minted here can sit BELOW rows
  /// a previous session left in the store — and every ordering comparison
  /// downstream then reads them as NEWER than a write that demonstrably began
  /// after them. Concretely, with one queued `rate: up` at `seq: 7` and a
  /// cold-start read that times out: the successful thumbs-down's sweep
  /// (`entry.seq <= startSeq`) misses it, `queue`'s `existing.seq > entry.seq`
  /// check refuses it, and the next [flushOutbox] replays the stale `up` over
  /// the rating the user just recorded while the UI still shows `down`. That
  /// is a silent server-side revert, not a durability cost.
  ///
  /// So the untrusted case is made explicit rather than papered over: the
  /// write proceeds, carrying [_TurnWrite.seqTrusted] `false`, and the two
  /// comparisons that only make sense against a trusted sequence step aside
  /// for it. See [_TurnWrite.seqTrusted] for why that is sound.
  ///
  /// The slot is released in a `finally`, and the future successors wait on is
  /// only ever COMPLETED, never completed with an error, so a write that
  /// throws costs itself and not the turn. Liveness against a request that
  /// simply never answers is [requestTimeout]'s job.
  Future<T> _runWrite<T>(
    String clientUserMessageId,
    Future<T> Function(_TurnWrite write) body,
  ) {
    // Read on the synchronous path, so the chain key is the account the user
    // acted under and matches the one [_TurnWrite] attributes the write to.
    final account = accountId();
    final key = (account, clientUserMessageId);
    final predecessor = _turnWrites[key];
    final released = Completer<void>();
    _turnWrites[key] = released.future;

    Future<T> run() async {
      try {
        if (predecessor != null) await predecessor;
        final (int startSeq, bool seqTrusted) = await _serialized(() async {
          var trusted = true;
          try {
            await _readLocked();
          } on Object catch (_) {
            // Fall through: `_nextSeq` is still monotonic within this run, but
            // it is no longer known to sit above the persisted queue.
            trusted = false;
          }
          return (_nextSeq(), trusted);
        });
        return await body(
          _TurnWrite._(
            this,
            account,
            clientUserMessageId,
            startSeq,
            seqTrusted,
          ),
        );
      } finally {
        // Only the LAST write on this key clears the slot; a write that
        // already has successors chained behind it must leave the tail they
        // are waiting on in place.
        if (identical(_turnWrites[key], released.future)) {
          _turnWrites.remove(key);
        }
        released.complete();
      }
    }

    return run();
  }

  int _nextSeq() => ++_seq;

  /// Whether a write of [kind] that began at [seq] has been overtaken.
  ///
  /// Strictly greater, never `>=`: an entry is compared against the watermark
  /// its OWN settle published ([flushOutbox] publishes at the replayed
  /// entry's exact sequence), and a write must never supersede itself out of
  /// its own retry.
  bool _isSuperseded(
    String? account,
    String turnId,
    int seq,
    FeedbackOutboxKind kind,
  ) {
    final settledSeq = _settled[(account, turnId)]?[kind];
    return settledSeq != null && settledSeq > seq;
  }

  /// Publishes a definite outcome at [seq] for the kinds in [supersedes]
  /// (null means every kind), raising each of those kinds independently.
  ///
  /// Raise-only, per kind. A write that STARTED earlier but settled later
  /// must not lower a watermark a newer write already raised, and a NARROW
  /// write (a `detail` PATCH) must not clear the kinds a broader earlier one
  /// raised — un-superseding writes that were correctly ruled out.
  void _recordSettled(
    String? account,
    String turnId,
    int seq,
    Set<FeedbackOutboxKind>? supersedes,
  ) {
    final key = (account, turnId);
    // Removed and re-inserted rather than updated in place so the map's
    // insertion order stays least-recently-settled first for the eviction
    // below.
    final watermark = _settled.remove(key) ?? <FeedbackOutboxKind, int>{};
    for (final kind in supersedes ?? FeedbackOutboxKind.values) {
      final existing = watermark[kind];
      if (existing == null || existing < seq) watermark[kind] = seq;
    }
    _settled[key] = watermark;
    while (_settled.length > settledWatermarkCapacity) {
      _settled.remove(_settled.keys.first);
    }
  }

  /// Builds the entry an `attachDetail` request should store, preserving the
  /// outbox's one-entry-per-turn invariant (`upsertFeedbackOutbox` keys on
  /// account + `clientUserMessageId`) instead of letting a `detail` insert
  /// silently replace a queued `rate` or `clear` in the same slot. Rules,
  /// matching `rate`'s unconditional replace and `clear`'s kind narrowing:
  ///
  /// - Nothing queued for this turn: insert a standalone `kind: detail`
  ///   entry. Requires [feedbackId] — with no feedbackId and nothing
  ///   queued there is no rating on this turn, synced or pending, to
  ///   attach anything to.
  /// - A pending `rate` (or `detail`) is queued: merge the reason/comment
  ///   into that entry, keeping its `kind` and payload otherwise unchanged
  ///   but taking a FRESH sequence (see the stamp's own comment below).
  ///   A queued `rate` already sends its merged reason/comment in the same
  ///   `flushOutbox` call that replays the rating, and a second `detail`
  ///   refines the first rather than competing with it for the one slot.
  /// - A pending `clear` is queued: drop the detail entirely (return null).
  ///   A comment attached to a turn the user is retracting describes a
  ///   rating that will not exist on the server.
  ///
  /// Pure and synchronous by construction: it runs inside [_TurnWrite.queue]'s
  /// critical section, which has already read the store and is what actually
  /// writes the result.
  FeedbackOutboxEntry? _buildQueuedDetail({
    required List<FeedbackOutboxEntry> entries,
    required int seq,
    required int Function() nextSeq,
    required String? account,
    required String clientUserMessageId,
    required String clientChatId,
    required String? feedbackId,
    required TurnFeedbackReason? reason,
    required String? comment,
  }) {
    FeedbackOutboxEntry? existing;
    for (final entry in entries) {
      if (entry.clientUserMessageId == clientUserMessageId &&
          entry.accountId == account) {
        existing = entry;
      }
    }

    if (existing == null) {
      final id = feedbackId;
      if (id == null) return null;
      return FeedbackOutboxEntry(
        kind: FeedbackOutboxKind.detail,
        clientUserMessageId: clientUserMessageId,
        clientChatId: clientChatId,
        accountId: account,
        feedbackId: id,
        reason: reason,
        comment: comment,
        queuedAtMs: now().millisecondsSinceEpoch,
        seq: seq,
      );
    }

    if (existing.kind == FeedbackOutboxKind.clear) return null;

    return FeedbackOutboxEntry(
      kind: existing.kind,
      clientUserMessageId: existing.clientUserMessageId,
      clientChatId: existing.clientChatId,
      accountId: existing.accountId,
      rating: existing.rating,
      reason: reason ?? existing.reason,
      comment: comment ?? existing.comment,
      feedbackId: existing.feedbackId,
      provider: existing.provider,
      model: existing.model,
      chatMode: existing.chatMode,
      appVersion: existing.appVersion,
      eventType: existing.eventType,
      queuedAtMs: now().millisecondsSinceEpoch,
      // A FRESH sequence, not `existing.seq`. `flushOutbox` removes what it
      // handled by exact (account, id, seq) triple, so a merge that lands
      // while this turn is mid-flight would otherwise still match the
      // in-flight run's removal set and be swept away — taking the user's
      // just-typed comment with it. Re-stamping makes the merged entry a
      // different row than the one being flushed, so it survives and replays
      // on the next flush.
      seq: nextSeq(),
    );
  }

  // --- Store-only critical sections. Never call these directly — always go
  // through `_serialized`, and never await a network call inside one. ---

  /// Every store read goes through here so the ordering counter is raised
  /// past whatever a previous run of the app persisted before any new
  /// sequence is issued.
  Future<List<FeedbackOutboxEntry>> _readLocked() async {
    final entries = await _readStore();
    for (final entry in entries) {
      if (entry.seq > _seq) _seq = entry.seq;
    }
    return entries;
  }

  /// Reads the queue and drops what has aged out, persisting the prune only
  /// when it actually changed something — the same "write only on a change"
  /// rule [_removeHandledLocked] and [_TurnWrite.settle] already follow, and
  /// the reason this was the odd one out mattered.
  ///
  /// This is the FIRST thing [flushOutbox] does, and its failure is caught
  /// there as "a broken store means there is nothing safe to read or send".
  /// That reasoning holds for a failed READ and not for a failed WRITE: on a
  /// readable-but-unwritable store (Android `Editor.commit()` returning false)
  /// the read succeeded, the queue is in hand and the server may be perfectly
  /// healthy — yet an unconditional write here made every flush return before
  /// opening a single request, so nothing queued ever reached the server
  /// again. Persisting the prune is bookkeeping: at worst the same aged-out
  /// entries are pruned again on the next flush.
  Future<List<FeedbackOutboxEntry>> _pruneAndReadLocked() async {
    final read = await _readLocked();
    final entries = pruneFeedbackOutbox(
      read,
      nowMs: now().millisecondsSinceEpoch,
    );
    if (entries.length != read.length) {
      try {
        await _writeStore(entries);
      } on Object catch (_) {
        // Bookkeeping only: the entries this call returns are the ones it can
        // still read and send, and the replay must not be paid for a prune
        // that could not be persisted.
      }
    }
    return entries;
  }

  Future<void> _removeHandledLocked(Set<(String?, String, int)> handled) async {
    if (handled.isEmpty) return;
    final entries = await _readLocked();
    final next = entries
        .where(
          (entry) => !handled.contains((
            entry.accountId,
            entry.clientUserMessageId,
            entry.seq,
          )),
        )
        .toList(growable: false);
    if (next.length != entries.length) await _writeStore(next);
  }
}

/// One write against one turn. See [_SettledWrite] for the discipline this
/// exists to enforce.
final class _TurnWrite {
  _TurnWrite._(
    this._repo,
    this.account,
    this.turnId,
    this.startSeq,
    this.seqTrusted,
  );

  final HttpTurnFeedbackRepository _repo;

  /// The account this write is attributed to, captured when the write began
  /// rather than re-read later: a sign-out mid-request must not file the
  /// entry under, or sweep the entries of, whoever is signed in by the time
  /// the response lands.
  final String? account;
  final String turnId;

  /// Where this write sits among all local writes. Everything queued before
  /// it has a strictly smaller sequence; everything queued after it, a
  /// strictly larger one — but only when [seqTrusted].
  final int startSeq;

  /// Whether [startSeq] is known to sit above every sequence already in the
  /// store, i.e. whether the [HttpTurnFeedbackRepository._readLocked] that
  /// issued it actually ran. False when that read failed or timed out.
  ///
  /// An untrusted [startSeq] is not merely imprecise, it is INVERTED: rows a
  /// previous session persisted keep their real sequences while this write
  /// gets a small one, so every `newer than` comparison answers backwards.
  /// The two comparisons that depend on it therefore fall back to the
  /// question they were approximating — IDENTITY: is this row this account's,
  /// for this turn, of a kind this write supersedes?
  ///
  /// That fallback is sound because the ordering it replaces is already known
  /// from the write's own position in time, without any sequence:
  ///
  /// - The failed read happened at the START of this write, so every row in
  ///   the store at that moment was persisted BEFORE this write began.
  /// - No row for this `(account, turn)` can appear between then and now.
  ///   [HttpTurnFeedbackRepository._runWrite] gives a `(account, turn)` at
  ///   most one in-flight write, and [queue] — reachable only from inside a
  ///   write — is the only thing in this class that INSERTS. The other two
  ///   store writers, [HttpTurnFeedbackRepository._pruneAndReadLocked] and
  ///   [HttpTurnFeedbackRepository._removeHandledLocked], only remove.
  /// - Rows for another account or another turn are excluded by the identity
  ///   predicate itself, and rows of a kind outside `supersedes` by the kind
  ///   filter — neither of which involves a sequence.
  ///
  /// So the set an untrusted write sweeps by identity is a SUBSET of the rows
  /// that were already persisted when it began, which is exactly the set the
  /// `entry.seq <= startSeq` clause is there to name. It is the per-turn
  /// serialization in `_runWrite` that makes this true; if a turn were ever
  /// allowed two concurrent writes again, identity-only sweeping would become
  /// unsafe and this flag would have to go back to refusing to sweep at all.
  final bool seqTrusted;

  /// Records a definite outcome.
  ///
  /// Publishes this write as the turn's newest settled state and removes the
  /// entries it superseded — this account's entries for this turn, of one of
  /// the [supersedes] kinds (null means every kind), queued before this write
  /// began. Returns what it removed.
  ///
  /// The published watermark carries the SAME [supersedes] set, which is what
  /// keeps the two halves of the discipline from drifting apart: an entry this
  /// write would have swept is exactly an entry a later-failing older write is
  /// refused permission to queue.
  Future<List<FeedbackOutboxEntry>> settle({
    Set<FeedbackOutboxKind>? supersedes,
  }) => _repo._serialized(() async {
    // In memory and infallible, and published FIRST: a store that is failing
    // must cost this turn its sweep, never its ordering. `settle` is awaited
    // on the SUCCESS path of every verb, so an escaping store error would
    // turn a write the server accepted into a thrown, unhandled one.
    _repo._recordSettled(account, turnId, startSeq, supersedes);
    late final int sweepSeq;
    bool superseded(FeedbackOutboxEntry entry) =>
        entry.clientUserMessageId == turnId &&
        entry.accountId == account &&
        (supersedes == null || supersedes.contains(entry.kind)) &&
        entry.seq <= sweepSeq;
    try {
      final entries = await _repo._readLocked();
      // A trusted write sweeps at its own sequence. An untrusted one cannot —
      // see [seqTrusted] — but the read that just succeeded has raised the
      // counter past every persisted sequence, so a freshly minted one is
      // above them all and `entry.seq <= sweepSeq` degrades to exactly the
      // identity-only sweep that flag argues for.
      //
      // Re-publishing the watermark at that same sequence is the other half,
      // and it is not redundant with the sweep: when the sweep's `write`
      // fails, the watermark is the ONLY thing standing between the surviving
      // rows and a [HttpTurnFeedbackRepository.flushOutbox] that replays them
      // over what the server just accepted. Left at `startSeq` it says
      // nothing, because `startSeq` is below their sequences.
      sweepSeq = seqTrusted ? startSeq : _repo._nextSeq();
      if (!seqTrusted) {
        _repo._recordSettled(account, turnId, sweepSeq, supersedes);
      }
      final removed = entries.where(superseded).toList(growable: false);
      if (removed.isEmpty) return removed;
      await _repo._writeStore(
        entries.where((entry) => !superseded(entry)).toList(growable: false),
      );
      return removed;
    } on Object catch (_) {
      // Nothing is claimed to have been removed, which is the conservative
      // direction: `clear` reports the retraction as unsynced rather than
      // asserting it dropped a pending rating it may not have.
      return const <FeedbackOutboxEntry>[];
    }
  });

  /// Stores the entry [build] returns, and reports whether anything was
  /// stored.
  ///
  /// Refuses in four cases, each of which means nothing will ever retry the
  /// write and the caller must report it as dropped:
  ///
  /// - No account to attribute the entry to. An unscoped entry could only
  ///   ever replay under whoever signs in next, which is the cross-account
  ///   leak `FeedbackOutboxEntry.accountId` exists to prevent.
  /// - [build] declined to produce an entry (nothing to attach a detail to, or
  ///   a pending retraction that supersedes it).
  /// - A newer write for this turn has already settled and supersedes this
  ///   entry's kind. This is the insertion half of the ordering rule: a
  ///   rating whose POST lost the race to a newer rating, or to a retraction,
  ///   must not be resurrected by the queue after the user has moved on.
  /// - The store itself failed. Nothing was persisted, so `false` is the
  ///   honest answer; see the class doc's store-degradation rule.
  Future<bool> queue(
    FeedbackOutboxKind writeKind,
    FeedbackOutboxEntry? Function(
      List<FeedbackOutboxEntry> queued,
      int seq,
      int Function() nextSeq,
    )
    build,
  ) => _repo._serialized(() async {
    if (account == null) return false;
    final List<FeedbackOutboxEntry> entries;
    try {
      entries = await _repo._readLocked();
    } on Object catch (_) {
      // A store that cannot be read cannot be queued into either. `false` is
      // the honest answer — nothing was stored — and it reaches the user as
      // `dropped`, rather than escaping `unawaited(onPressed())` from inside
      // a catch block.
      return false;
    }
    // The watermark is for the verb that FAILED, not for the kind of the row
    // it may merge into. These are two different questions that used to share
    // one argument: a failed `detail` merged into a queued `rate` is still
    // stale when a newer detail has settled, even though the row it would
    // write carries `kind: rate`. (The BUILT kind is the right one for the
    // sweep direction — see [settle] — which is why they cannot be unified.)
    if (_repo._isSuperseded(account, turnId, startSeq, writeKind)) {
      return false;
    }

    // Non-merge insertions retain the sequence minted when their request
    // BEGAN. Stamping at failure time (a fresh `_nextSeq()` here) would make
    // an older slow request look newer than a later fast one, so a newer
    // write's sweep — which removes `entry.seq <= startSeq` — would miss it
    // and the stale entry would replay. `_buildQueuedDetail` alone mints a
    // fresh sequence, and only when it genuinely merges new detail into an
    // existing row, so that merge survives a flush already handling the old
    // row identity.
    final entry = build(entries, startSeq, _repo._nextSeq);
    if (entry == null) return false;

    // A retryable failure never settles, so the watermark alone cannot order
    // queue against queue: nothing compared this write against the entry it is
    // about to REPLACE. Refuse when that entry is strictly newer than the row
    // we would put in its place.
    //
    // What can actually reach this branch is narrower than it looks, and the
    // narrowing is worth stating so nobody later either deletes it as dead or
    // relies on it to catch a race it can no longer catch:
    //
    // - NOT a previous run of the app. Its rows are already in the store when
    //   this run starts, and [_readLocked] raises `_seq` past every sequence
    //   it reads BEFORE `startSeq` is issued — so a persisted row is always
    //   strictly older than any entry this write would store.
    // - NOT a concurrent verb against this turn. [_runWrite] gives a turn one
    //   in-flight write at a time, so there is no sibling to race.
    //
    // What remains is a store mutated from outside this write's ordering: a
    // [flushOutbox] merge re-stamp landing mid-request, or anything else that
    // writes the store directly. The guard is therefore defence in depth
    // rather than the thing standing between the user and a lost rating —
    // cheap, exact, and the one check that still holds if a fourth writer is
    // ever added.
    //
    // Compared against the entry being written rather than against `startSeq`
    // so the merge path is exempt BY CONSTRUCTION rather than by a special
    // case: a non-merge insertion carries exactly `startSeq` (above), while a
    // genuine merge re-stamps with a fresh sequence and is therefore always
    // ahead of the row it merged into — which is the intended behavior, since
    // merging a just-typed reason and comment into a newer queued rating is
    // how that comment survives at all.
    FeedbackOutboxEntry? existing;
    for (final candidate in entries) {
      if (candidate.accountId == account &&
          candidate.clientUserMessageId == turnId) {
        existing = candidate;
      }
    }
    //
    // Skipped entirely when this write's sequence is not trusted: `existing`
    // is then a row from a previous session whose real sequence outranks a
    // counter that was never raised past it, so the comparison would refuse
    // the very write it exists to protect — see [seqTrusted].
    if (seqTrusted && existing != null && existing.seq > entry.seq) {
      return false;
    }
    try {
      await _repo._writeStore(
        pruneFeedbackOutbox(
          upsertFeedbackOutbox(entries, entry),
          nowMs: _repo.now().millisecondsSinceEpoch,
        ),
      );
    } on Object catch (_) {
      return false;
    }
    return true;
  });
}

/// In-memory repository for mock mode and widget tests.
class MockTurnFeedbackRepository implements TurnFeedbackRepository {
  MockTurnFeedbackRepository({
    this.latency = Duration.zero,
    this.failWrites = false,
  });

  final Duration latency;

  /// When true every write reports `synced: false`, exercising the offline
  /// path without a network stub.
  final bool failWrites;

  final Map<String, TurnFeedbackSummary> _rows =
      <String, TurnFeedbackSummary>{};
  int _nextId = 1;

  /// Avoids creating a timer for zero latency, so widget tests can drain
  /// mock writes through microtasks without an extra pump.
  Future<void> _delay() => latency == Duration.zero
      ? Future<void>.value()
      : Future<void>.delayed(latency);

  @override
  Future<List<TurnFeedbackSummary>> listForChat(String clientChatId) async {
    await _delay();
    return _rows.values.toList(growable: false);
  }

  @override
  Future<TurnFeedbackWriteResult> rate({
    required String clientUserMessageId,
    required String clientChatId,
    required TurnFeedbackRating rating,
    required TurnFeedbackContext context,
  }) async {
    await _delay();
    if (failWrites) return const TurnFeedbackWriteResult(synced: false);
    final id = 'mock-fb-${_nextId++}';
    _rows[clientUserMessageId] = TurnFeedbackSummary(
      feedbackId: id,
      clientUserMessageId: clientUserMessageId,
      rating: rating,
      hasComment: false,
    );
    return TurnFeedbackWriteResult(synced: true, feedbackId: id);
  }

  @override
  Future<TurnFeedbackWriteResult> attachDetail({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
    TurnFeedbackReason? reason,
    String? comment,
  }) async {
    await _delay();
    // Mirrors `rate`: [failWrites] models the OFFLINE path (durably queued),
    // never an outright refusal, so `dropped` stays false.
    if (failWrites) return const TurnFeedbackWriteResult(synced: false);
    return const TurnFeedbackWriteResult(synced: true);
  }

  @override
  Future<TurnFeedbackWriteResult> clear({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
  }) async {
    await _delay();
    if (failWrites) return const TurnFeedbackWriteResult(synced: false);
    _rows.remove(clientUserMessageId);
    return const TurnFeedbackWriteResult(synced: true);
  }

  @override
  Future<List<TurnFeedbackReplayedRating>> flushOutbox() async =>
      const <TurnFeedbackReplayedRating>[];
}

/// Delegates every call to either [http] or [mock] based on a LIVE
/// [isConfigured] check — re-evaluated on every call — rather than a choice
/// frozen once at construction.
///
/// This exists for callers that hold a single, app-lifetime
/// [TurnFeedbackRepository] instance (see `TurnFeedbackController`'s doc
/// comment in `main.dart`) where the underlying config (e.g. reviewer demo
/// mode, toggled at runtime via `DemoMode.enabled`) can change after
/// construction. A repository chosen once at construction time would freeze
/// that decision for the app's entire lifetime; this defers it to each call
/// instead, while still keeping [http] and [mock] as stable, reused
/// instances so their own internal state (the HTTP repository's outbox
/// write-serialization chain; the mock's in-memory rows) behaves normally
/// across calls — only the ROUTING decision is live, not the repositories
/// themselves.
final class LiveConfigTurnFeedbackRepository implements TurnFeedbackRepository {
  LiveConfigTurnFeedbackRepository({
    required this.isConfigured,
    required this.http,
    required this.mock,
  });

  /// Re-checked on every call. `true` routes to [http]; `false` routes to
  /// [mock].
  final bool Function() isConfigured;

  final TurnFeedbackRepository http;
  final TurnFeedbackRepository mock;

  TurnFeedbackRepository get _active => isConfigured() ? http : mock;

  @override
  Future<List<TurnFeedbackSummary>> listForChat(String clientChatId) =>
      _active.listForChat(clientChatId);

  @override
  Future<TurnFeedbackWriteResult> rate({
    required String clientUserMessageId,
    required String clientChatId,
    required TurnFeedbackRating rating,
    required TurnFeedbackContext context,
  }) => _active.rate(
    clientUserMessageId: clientUserMessageId,
    clientChatId: clientChatId,
    rating: rating,
    context: context,
  );

  @override
  Future<TurnFeedbackWriteResult> attachDetail({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
    TurnFeedbackReason? reason,
    String? comment,
  }) => _active.attachDetail(
    clientUserMessageId: clientUserMessageId,
    clientChatId: clientChatId,
    feedbackId: feedbackId,
    reason: reason,
    comment: comment,
  );

  @override
  Future<TurnFeedbackWriteResult> clear({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
  }) => _active.clear(
    clientUserMessageId: clientUserMessageId,
    clientChatId: clientChatId,
    feedbackId: feedbackId,
  );

  @override
  Future<List<TurnFeedbackReplayedRating>> flushOutbox() =>
      _active.flushOutbox();
}
