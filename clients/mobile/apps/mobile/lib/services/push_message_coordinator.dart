import 'dart:async';

import 'package:flutter/foundation.dart';

import '../data/services/push_messaging.dart';

/// Turns notification taps — background taps and cold-start launches — into
/// [pendingTap], which the authenticated shell consumes to navigate.
/// Foreground messages are deliberately not surfaced in the app: the user is
/// already working, and the OS presents the notification when the app is in
/// the background. Best-effort throughout: push handling must never break
/// app startup.
final class PushMessageCoordinator {
  PushMessageCoordinator({required this.messaging});

  final PushMessaging messaging;

  /// The notification tap waiting to be turned into navigation; null when
  /// nothing is pending. Consumed (and cleared) by PushTapBinding.
  final ValueNotifier<PushMessage?> pendingTap = ValueNotifier<PushMessage?>(
    null,
  );

  StreamSubscription<PushMessage>? _openedSubscription;
  bool _started = false;
  int _generation = 0;

  /// Starts listening and consumes the cold-start initial message, if any.
  /// Safe to call more than once; never throws.
  Future<void> start() async {
    if (_started) return;
    _started = true;
    final generation = ++_generation;
    try {
      _openedSubscription = messaging.onNotificationOpened.listen((message) {
        if (_started && _generation == generation) {
          requestOpen(message);
        }
      });
      final initial = await messaging.getInitialMessage();
      if (_started &&
          _generation == generation &&
          initial != null &&
          pendingTap.value == null) {
        pendingTap.value = initial;
      }
    } catch (_) {
      // Best-effort: push handling must never break app startup.
    }
  }

  /// Queues [message] for deep-link navigation.
  void requestOpen(PushMessage message) {
    if (!_started) return;
    pendingTap.value = message;
  }

  void clearPendingTap() {
    pendingTap.value = null;
  }

  /// Stops user-scoped push handling and clears queued navigation state.
  ///
  /// Safe to call more than once. A later [start] creates fresh subscriptions;
  /// callbacks and initial-message reads from an earlier generation are
  /// ignored even if they complete after this method returns.
  Future<void> stop() async {
    if (!_started && _openedSubscription == null) {
      clearPendingTap();
      return;
    }
    _started = false;
    _generation++;
    final openedSubscription = _openedSubscription;
    _openedSubscription = null;
    clearPendingTap();
    try {
      await openedSubscription?.cancel();
    } catch (_) {
      // Best-effort: sign-out must not fail because stream cleanup failed.
    }
  }

  Future<void> dispose() async {
    await stop();
    pendingTap.dispose();
  }
}
