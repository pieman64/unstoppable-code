import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';

/// Per-chat turn rating state for the mobile transcript.
///
/// Writes are optimistic: the thumb selects on tap and settles to `synced` or
/// `failed` when the repository answers. A `failed` rating KEEPS its selection
/// — the repository has durably queued it, and silently un-selecting the user's
/// tap would be a lie about what happened. A DROPPED write is the opposite
/// case: it was refused outright and never queued, so nothing will retry it
/// and the selection is reverted, because leaving a thumb selected for a write
/// that will never land is the same lie in the other direction.
final class TurnFeedbackController extends ChangeNotifier {
  TurnFeedbackController({required this.repository});

  final TurnFeedbackRepository repository;
  final Map<String, Map<String, TurnFeedbackEntry>> _byChat =
      <String, Map<String, TurnFeedbackEntry>>{};

  /// Changes on account reset so an old outbox replay cannot update the
  /// current account's entries.
  int _accountGeneration = 0;

  /// Monotonically increasing per-`(chatId, clientUserMessageId)` write
  /// token. Every `setRating` call — including a clear — issues a fresh
  /// token before awaiting the repository, and only the write whose token is
  /// still the latest issued for that key is allowed to settle the entry.
  /// This is identity, not value, comparison: two writes that happen to
  /// carry the same rating (a double-tap, or up->down->up) must not let a
  /// late-resolving earlier write re-settle over a newer one just because
  /// their ratings match.
  ///
  /// Bounded by [writeTokenCapacity], for the same reason
  /// `HttpTurnFeedbackRepository._settled` is bounded and with the same
  /// eviction: this controller is an app-lifetime singleton (see `main.dart`),
  /// so an unbounded map here grows by one entry for every turn the user ever
  /// rates and is never released — [resetHydration] deliberately does not
  /// clear it, so not even a sign-out bounds it.
  final Map<String, Map<String, int>> _writeTokens =
      <String, Map<String, int>>{};

  /// The bound on [_writeTokens], counted in turns across all chats. Public
  /// because the test that pins the eviction cost has to issue MORE than this
  /// many tokens to observe it; hard-coding a number there would silently turn
  /// that test into a no-op the moment the capacity grew.
  ///
  /// Evicting a turn's token costs exactly what never having written it costs:
  /// a still-in-flight write for that turn stops being "the latest" and
  /// declines to settle. The least-recently-written turn is the one least
  /// likely to still have a write in flight against it.
  static const int writeTokenCapacity = 500;

  TurnFeedbackEntry? entryFor(String chatId, String clientUserMessageId) =>
      _byChat[chatId]?[clientUserMessageId];

  int _issueToken(String chatId, String clientUserMessageId) {
    // Removed and re-inserted at both levels rather than updated in place, so
    // insertion order stays least-recently-written first for the eviction
    // below.
    final chatTokens = _writeTokens.remove(chatId) ?? <String, int>{};
    final previous = chatTokens.remove(clientUserMessageId);
    final next = (previous ?? 0) + 1;
    chatTokens[clientUserMessageId] = next;
    _writeTokens[chatId] = chatTokens;
    _evictWriteTokens();
    return next;
  }

  /// Drops least-recently-written turns until [_writeTokens] holds at most
  /// [writeTokenCapacity] of them.
  ///
  /// The token just issued is never the victim: [_issueToken] re-inserts it
  /// last within a chat that is itself re-inserted last, and each pass removes
  /// exactly one entry from the FRONT.
  void _evictWriteTokens() {
    var total = 0;
    for (final chatTokens in _writeTokens.values) {
      total += chatTokens.length;
    }
    while (total > writeTokenCapacity && _writeTokens.isNotEmpty) {
      final oldestChatId = _writeTokens.keys.first;
      final chatTokens = _writeTokens[oldestChatId];
      if (chatTokens == null || chatTokens.isEmpty) {
        _writeTokens.remove(oldestChatId);
        continue;
      }
      chatTokens.remove(chatTokens.keys.first);
      total -= 1;
      if (chatTokens.isEmpty) _writeTokens.remove(oldestChatId);
    }
  }

  bool _isLatestToken(String chatId, String clientUserMessageId, int token) =>
      _writeTokens[chatId]?[clientUserMessageId] == token;

  /// Clears cached ratings when the signed-in account changes.
  ///
  /// Keep write tokens monotonic so a stale write cannot settle over a new
  /// account's write for the same turn.
  void resetHydration() {
    _accountGeneration++;
    _byChat.clear();
    notifyListeners();
  }

  /// Records (or, with a null [rating], retracts) one turn's rating.
  ///
  /// Returns whether the write STANDS: true when it synced or was durably
  /// queued, false when it was dropped and the optimistic selection has been
  /// rolled back. The thumbs-down sheet is gated on this — collecting a reason
  /// for a rating that will never exist would discard whatever the user typed
  /// (the server's PATCH guard rejects a detail whose rating is not `DOWN`).
  /// A write superseded by a newer one for the same turn also returns false:
  /// it no longer owns the turn's state and must not drive UI off it.
  Future<bool> setRating({
    required String chatId,
    required String clientUserMessageId,
    required TurnFeedbackRating? rating,
    TurnFeedbackContext context = const TurnFeedbackContext(),
  }) async {
    final chat = _byChat.putIfAbsent(
      chatId,
      () => <String, TurnFeedbackEntry>{},
    );
    final existing = chat[clientUserMessageId];
    // Issued before the optimistic mutation below so that ANY later write for
    // this key — rate or clear — invalidates this one, even one issued while
    // this call is still on the synchronous path before its first `await`.
    final token = _issueToken(chatId, clientUserMessageId);

    if (rating == null) {
      chat.remove(clientUserMessageId);
      notifyListeners();
      final result = await repository.clear(
        clientUserMessageId: clientUserMessageId,
        clientChatId: chatId,
        feedbackId: existing?.feedbackId,
      );
      // Same latest-write rule the rating path uses below.
      if (!_isLatestToken(chatId, clientUserMessageId, token)) return false;
      // A retraction refused outright never reached the server and was not
      // queued, so the rating is still recorded there. Leaving the thumb
      // unselected would claim a retraction that did not happen — the mirror
      // image of keeping a thumb selected for a dropped rating.
      if (!result.synced && result.dropped) {
        if (existing != null) {
          chat[clientUserMessageId] = existing;
          notifyListeners();
        }
        return false;
      }
      return true;
    }

    chat[clientUserMessageId] = TurnFeedbackEntry(
      rating: rating,
      syncState: TurnFeedbackSyncState.pending,
      feedbackId: existing?.feedbackId,
    );
    notifyListeners();

    final result = await repository.rate(
      clientUserMessageId: clientUserMessageId,
      clientChatId: chatId,
      rating: rating,
      context: context,
    );

    // The user may have cleared or issued another write for this turn while
    // this one was in flight; only the write that is still the latest issued
    // for this key is allowed to settle it.
    if (!_isLatestToken(chatId, clientUserMessageId, token)) return false;

    // A DROPPED write was refused outright and was not queued: nothing will
    // ever retry it, so the optimistic selection is reverted to whatever was
    // there before the tap. A merely `failed` (queued) write keeps its
    // selection — that is deliberate desktop parity, because the write is
    // still going to land.
    if (!result.synced && result.dropped) {
      if (existing == null) {
        chat.remove(clientUserMessageId);
      } else {
        chat[clientUserMessageId] = existing;
      }
      notifyListeners();
      return false;
    }

    final current = chat[clientUserMessageId];
    if (current == null) return false;
    chat[clientUserMessageId] = current.copyWith(
      syncState: result.synced
          ? TurnFeedbackSyncState.synced
          : TurnFeedbackSyncState.failed,
      feedbackId: result.feedbackId ?? current.feedbackId,
    );
    notifyListeners();
    return true;
  }

  /// Attaches a reason and/or comment to one turn's existing rating.
  ///
  /// Returns whether the detail STANDS, on exactly the rule [setRating] uses:
  /// true when it synced or was durably queued, false when it was dropped —
  /// refused outright, superseded by a newer write for the same turn, or with
  /// nothing to attach it to — and the optimistically applied reason has been
  /// rolled back.
  ///
  /// A `void` return made a dropped detail indistinguishable from a delivered
  /// one at the call site: the user's typed comment is gone and the caller had
  /// no way to know. Reporting it does not by itself put anything on screen;
  /// it makes that a decision the caller is able to make.
  Future<bool> submitDetail({
    required String chatId,
    required String clientUserMessageId,
    TurnFeedbackReason? reason,
    String? comment,
  }) async {
    final chat = _byChat[chatId];
    final existing = chat?[clientUserMessageId];
    TurnFeedbackEntry? optimistic;
    if (chat != null && existing != null && reason != null) {
      optimistic = existing.copyWith(reason: reason);
      chat[clientUserMessageId] = optimistic;
      notifyListeners();
    }
    final result = await repository.attachDetail(
      clientUserMessageId: clientUserMessageId,
      clientChatId: chatId,
      feedbackId: existing?.feedbackId,
      reason: reason,
      comment: comment,
    );
    // Same rule as a dropped rating: the detail was refused outright and was
    // not queued, so nothing will ever carry this reason to the server and
    // rendering it would misreport what happened. A merely queued detail
    // keeps its optimistic reason — it is still going to land.
    if (result.synced || !result.dropped) return true;
    if (chat == null || existing == null || optimistic == null) return false;
    // Identity, not equality: only roll back if this call's own optimistic
    // entry is still the one in the cache. A newer rating or retraction for
    // the same turn has already replaced it and must not be clobbered.
    if (!identical(chat[clientUserMessageId], optimistic)) return false;
    chat[clientUserMessageId] = existing;
    notifyListeners();
    return false;
  }

  /// Replays whatever the durable outbox still owes the server, and adopts the
  /// `feedbackId` of every rating that replayed.
  ///
  /// The adoption is the point, not a side effect. A rating queued while
  /// offline is created SERVER-SIDE here rather than in [setRating], and until
  /// this method carries its id back the entry keeps `feedbackId: null` for
  /// the rest of the session.
  /// A later retraction then takes the repository's "there is nothing on the
  /// server to retract" branch — true while the rate was still pending, false
  /// the moment the flush drained it — issuing no DELETE while reporting
  /// success, and a comment typed afterwards has no id to PATCH.
  ///
  /// [TurnFeedbackEntry.syncState] is deliberately left alone. Nothing renders
  /// `failed` differently from `synced` today, and a `pending` entry belongs to
  /// a NEWER write that is still in flight and must settle itself.
  Future<void> flushOutbox() async {
    // A replay started under a previous account must not supply feedback IDs
    // to entries created after an account reset.
    final generation = _accountGeneration;
    final replayed = await repository.flushOutbox();
    if (replayed.isEmpty) return;
    if (generation != _accountGeneration) return;
    var applied = false;
    for (final rating in replayed) {
      final chat = _byChat[rating.clientChatId];
      final existing = chat?[rating.clientUserMessageId];
      // Nothing cached for this turn (never opened this session, or cleared
      // by a retraction while the flush ran): there is no entry to correct,
      // and inventing one would resurrect a rating the user let go of.
      if (chat == null || existing == null) continue;
      if (existing.feedbackId == rating.feedbackId) continue;
      chat[rating.clientUserMessageId] = existing.copyWith(
        feedbackId: rating.feedbackId,
      );
      applied = true;
    }
    // Nothing observable changed.
    if (!applied) return;
    notifyListeners();
  }
}
