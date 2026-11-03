import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_watcher.dart';
import 'package:mobile/ui/features/remote/view_models/chat_watcher_card_presentation.dart';

void main() {
  final now = DateTime.utc(2026, 10, 27, 15);

  RemoteWatcher watcher(Map<String, dynamic> overrides) =>
      RemoteWatcher.fromJson({
        'id': 'w-1',
        'projectId': 'ws-1',
        'worktreeId': 'wt-1',
        'chatId': 'chat-1',
        'trigger': 'github_workflow_runs_changed',
        'status': 'active',
        'createdAt': '2026-10-27T12:00:00.000Z',
        'display': {
          'title': 'CI workflow',
          'subtitle': 'GitHub workflow runs',
          'watching': 'acme/app',
          'watchingSubtitle': 'ci.yml',
          'status': 'Active',
          'details': [
            {'label': 'Repository', 'value': 'acme/app'},
          ],
          'github': {
            'subtitle': 'acme/app',
            'filters': [
              {'label': 'Branch', 'value': 'main'},
            ],
            'samples': ['#41 ci.yml', '#42 ci.yml'],
            'totalCount': 5,
          },
        },
        ...overrides,
      })!;

  test('keeps desktop strings and modal row order', () {
    final card = ChatWatcherCardPresentation.from(
      watcher({
        'followUpInstruction': 'Report back.',
        'display': {
          ...watcher({}).display!.toJson(),
          'ownerDelegate': {'name': 'Reviewer', 'detail': 'Delegate chat'},
        },
      }),
      subscribedChat: 'Fix login',
      now: now,
    );

    expect(card.title, 'CI workflow');
    expect(card.subtitle, 'GitHub workflow runs');
    expect(
      [for (final row in card.rows) (row.label, row.value)],
      [
        ('Watching', 'acme/app · ci.yml'),
        ('Subscribed chat', 'Fix login'),
        ('Delegate', 'Reviewer · Delegate chat'),
        ('Created', '3h ago'),
        ('Status', 'Active'),
      ],
    );
    expect(card.githubFilters, ['Branch: main']);
    expect(card.githubSamples, ['#41 ci.yml', '#42 ci.yml']);
    expect(card.githubOverflow, 3);
    expect(card.followUp, 'Report back.');
  });

  test('shows the delivery error only for a failed delivery', () {
    final failed = ChatWatcherCardPresentation.from(
      watcher({
        'status': 'delivery_failed',
        'deliveryError': 'The watcher notification could not be delivered.',
      }),
      subscribedChat: 'Fix login',
      now: now,
    );
    expect(failed.rows.last.label, 'Delivery error');
    expect(failed.rows.last.isError, isTrue);

    final active = ChatWatcherCardPresentation.from(
      watcher({'deliveryError': 'stale'}),
      subscribedChat: 'Fix login',
      now: now,
    );
    expect(
      active.rows.map((row) => row.label),
      isNot(contains('Delivery error')),
    );
    expect(active.followUp, isNull);
  });
}
