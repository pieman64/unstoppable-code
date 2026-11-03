import 'dart:math' as math;

import 'package:mobile/data/models/remote_watcher.dart';
import 'package:mobile/ui/core/format.dart';

/// One "Chat watchers" card's lines, in `WatcherManagementModal.tsx` order.
/// The desktop formats every display string; this only joins the pairs the
/// modal joins and picks which rows apply.
class ChatWatcherCardPresentation {
  const ChatWatcherCardPresentation({
    required this.title,
    required this.rows,
    this.subtitle,
    this.githubFilters = const [],
    this.githubSamples = const [],
    this.githubOverflow = 0,
    this.followUp,
  });

  factory ChatWatcherCardPresentation.from(
    RemoteWatcher watcher, {
    required String subscribedChat,
    required DateTime now,
  }) {
    final display = watcher.display;
    final github = display?.github;
    final created = watcher.createdAt == null
        ? ''
        : formatRelativeTime(watcher.createdAt!, now: now);
    final deliveryError = watcher.deliveryError;
    final followUp = watcher.followUpInstruction;
    return ChatWatcherCardPresentation(
      title: _present(display?.title) ?? 'Watcher',
      subtitle: _present(display?.subtitle),
      rows: [
        if (_present(display?.watching) case final watching?)
          ChatWatcherCardRow(
            'Watching',
            _joined(watching, display?.watchingSubtitle),
          ),
        ChatWatcherCardRow('Subscribed chat', subscribedChat),
        if (display?.ownerDelegate case final owner?)
          ChatWatcherCardRow('Delegate', _joined(owner.name, owner.detail)),
        if (created.isNotEmpty) ChatWatcherCardRow('Created', created),
        if (_present(display?.status) case final status?)
          ChatWatcherCardRow('Status', status),
        if (watcher.status == 'delivery_failed' &&
            deliveryError != null &&
            deliveryError.isNotEmpty)
          ChatWatcherCardRow('Delivery error', deliveryError, isError: true),
      ],
      githubFilters: [
        for (final filter in github?.filters ?? const <RemoteWatcherDetail>[])
          '${filter.label}: ${filter.value}',
      ],
      githubSamples: github?.samples ?? const [],
      githubOverflow: switch (github) {
        RemoteWatcherGithubDisplay(:final totalCount?, :final samples) =>
          math.max(0, totalCount - samples.length),
        _ => 0,
      },
      followUp: followUp == null || followUp.isEmpty ? null : followUp,
    );
  }

  final String title;
  final String? subtitle;
  final List<ChatWatcherCardRow> rows;
  final List<String> githubFilters;
  final List<String> githubSamples;

  /// GitHub matches beyond the projected samples, shown as "+N more".
  final int githubOverflow;
  final String? followUp;
}

class ChatWatcherCardRow {
  const ChatWatcherCardRow(this.label, this.value, {this.isError = false});

  final String label;
  final String value;
  final bool isError;
}

String? _present(String? value) =>
    value == null || value.isEmpty ? null : value;

String _joined(String value, String? detail) =>
    _present(detail) == null ? value : '$value · $detail';
