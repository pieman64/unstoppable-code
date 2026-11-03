import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/auth_session.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/protocol/generated/usage.dart';

import '../../support/usage_fixture.dart';

void main() {
  group('FeedPageResponse.fromJson', () {
    test('parses a mixed page and dispatches variants by discriminator', () {
      final json = <String, dynamic>{
        'items': <dynamic>[
          <String, dynamic>{
            'id': 'f1',
            'type': 'agent_session',
            'occurredAt': '2026-06-30T12:00:00.000Z',
            'actor': <String, dynamic>{
              'userId': 'u1',
              'displayName': 'Sarah Lin',
            },
            'worktreeId': 'wt1',
            'clientChatId': 'c1',
            'turnCount': 18,
            'latestStatus': 'SUCCESS',
            'latestModel': 'claude-opus-4-8',
            'totalCostUsd': 2.41,
            'toolUseCount': 12,
          },
          <String, dynamic>{
            'id': 'f2',
            'type': 'pr_merged',
            'occurredAt': '2026-06-30T11:00:00.000Z',
            'actor': <String, dynamic>{'userId': 'u2', 'displayName': null},
            'worktreeId': null,
            'repoName': 'web-app',
            'prNumber': 482,
            'prUrl': 'https://example.test/pr/482',
            'title': 'Merge it',
            'branchName': 'feat/x',
            'summary': null,
            'additions': 10,
            'deletions': null,
            'changedFiles': 3,
            'totalCostUsd': null,
            'totalTokens': null,
            'models': <String>['claude-opus-4-8', 'gpt-5-codex'],
            'planId': null,
            'runUrl': null,
          },
          <String, dynamic>{
            'id': 'f3',
            'type': 'run_failed',
            'occurredAt': '2026-06-29T09:00:00.000Z',
            'actor': <String, dynamic>{'userId': 'u3', 'displayName': 'CI'},
            'worktreeId': null,
            'clientChatId': null,
            'label': 'nightly-e2e',
            'status': 'FAILURE',
            'model': null,
            'notificationWorthy': true,
          },
          // Regression guard for protocol drift: the server added the
          // run_shared feed variant. A stale binding without RunSharedFeedItem
          // throws FormatException in FeedItemType.fromWire, which fails the
          // whole page parse and blanks the feed.
          <String, dynamic>{
            'id': 'f4',
            'type': 'run_shared',
            'occurredAt': '2026-06-28T08:00:00.000Z',
            'actor': <String, dynamic>{'userId': 'u4', 'displayName': 'Dana'},
            'worktreeId': 'wt4',
            'model': 'claude-opus-4-8',
            'shareScope': 'org',
            'sharedRunId': 'run-777',
            'status': 'completed',
            'title': 'Refactor the payments module',
            'toolUseCount': 34,
            'totalCostUsd': 5.12,
            'turnCount': 22,
          },
        ],
        'nextCursor': null,
      };

      final page = FeedPageResponse.fromJson(json);
      expect(page.items, hasLength(4));
      expect(page.nextCursor, isNull);

      expect(page.items[0], isA<AgentSessionFeedItem>());
      final agent = page.items[0] as AgentSessionFeedItem;
      expect(agent.type, FeedItemType.agentSession);
      expect(agent.actor.displayName, 'Sarah Lin');
      // Generated models keep ISO dates as String (accepted codegen divergence).
      expect(agent.occurredAt, '2026-06-30T12:00:00.000Z');
      expect(agent.turnCount, 18);
      expect(agent.totalCostUsd, 2.41);

      expect(page.items[1], isA<PrMergedFeedItem>());
      final pr = page.items[1] as PrMergedFeedItem;
      expect(pr.actor.displayName, isNull);
      expect(pr.worktreeId, isNull);
      expect(pr.additions, 10);
      expect(pr.deletions, isNull);
      expect(pr.models, ['claude-opus-4-8', 'gpt-5-codex']);

      final failed = page.items[2] as RunFailedFeedItem;
      expect(failed.label, 'nightly-e2e');
      expect(failed.notificationWorthy, isTrue);
      expect(failed.clientChatId, isNull);

      expect(page.items[3], isA<RunSharedFeedItem>());
      final shared = page.items[3] as RunSharedFeedItem;
      expect(shared.type, FeedItemType.runShared);
      expect(shared.sharedRunId, 'run-777');
      expect(shared.shareScope, 'org');
      expect(shared.turnCount, 22);
      expect(shared.toolUseCount, 34);
      expect(shared.totalCostUsd, 5.12);
      expect(shared.model, 'claude-opus-4-8');
    });

    test('throws on an unknown feed item type', () {
      expect(
        () => FeedItem.fromJson(<String, dynamic>{'type': 'totally_new'}),
        throwsFormatException,
      );
    });
  });

  group('OrganizationDetail.fromJson', () {
    test('parses members, role gating, and enforced sync', () {
      final json = <String, dynamic>{
        'id': 'org1',
        'name': 'Acme',
        'viewerRole': 'ADMIN',
        'members': <dynamic>[
          <String, dynamic>{
            'id': 'm1',
            'name': 'Sarah',
            'email': 's@a.test',
            'image': null,
            'role': 'OWNER',
            'subTeamIds': <dynamic>['t1', 't2'],
          },
        ],
        'subTeams': <dynamic>[
          <String, dynamic>{'id': 't1', 'name': 'Core', 'memberCount': 4},
        ],
        'usageStatsMinRole': 'MEMBER',
        'canViewUsageStats': true,
        'githubConnection': <String, dynamic>{'connected': false},
        'enforcedSync': <String, dynamic>{
          'transcripts': true,
          'plans': false,
          'metadata': true,
        },
      };

      final org = OrganizationDetail.fromJson(json);
      expect(org.viewerRole, OrganizationRole.admin);
      expect(org.members, hasLength(1));
      expect(org.members.first.role, OrganizationRole.owner);
      expect(org.members.first.subTeamIds, <String>['t1', 't2']);
      expect(org.canViewUsageStats, isTrue);
      expect(org.enforcedSync?.transcripts, isTrue);
      expect(org.enforcedSync?.plans, isFalse);
    });
  });

  group('TeamUsageResponse.fromJson', () {
    test('parses headline cards and most-expensive runs', () {
      final json = <String, dynamic>{
        'scope': 'organization',
        'teamId': null,
        'range': <String, dynamic>{
          'startIso': '2026-06-23T00:00:00.000Z',
          'endIso': '2026-06-30T00:00:00.000Z',
          'granularity': 'day',
        },
        'filterUserId': null,
        'headline': <dynamic>[
          <String, dynamic>{
            'key': 'totalCostUsd',
            'label': 'Observed cost',
            'value': 8700.0,
            'previousValue': 7270.0,
            'unit': 'currency',
          },
          <String, dynamic>{
            'key': 'turns',
            'label': 'Agent turns',
            'value': 5959,
            'previousValue': null,
            'unit': 'count',
          },
        ],
        // All arrays are required by the complete generated TeamUsageResponse:
        'tokensByProvider': <dynamic>[],
        'tokensByModel': <dynamic>[],
        'costByProvider': <dynamic>[],
        'costByModel': <dynamic>[],
        'toolCategoryTotals': <dynamic>[],
        'eventTypeStatusCounts': <dynamic>[],
        // Populated, not `[]`: an empty list parses no rows, which is exactly
        // how an additive field on a row type reached users twice with green
        // CI (2026-07-08, 2026-08-13).
        'byUser': <dynamic>[buildLeaderboardRowJson()],
        'impactByUser': <dynamic>[
          <String, dynamic>{
            'bucketStartIso': '2026-06-23T00:00:00.000Z',
            'impactScore': 12.5,
            'key': 'Ada L.',
          },
        ],
        'pipelines': <dynamic>[],
        'mostExpensiveRuns': <dynamic>[
          <String, dynamic>{
            'sessionId': 'wt1:r1',
            'turnCount': 5,
            'label': 'Worktree Chat',
            'provider': 'anthropic',
            'model': 'claude-opus-4-8',
            'totalCostUsd': 133.95,
            'startedAtIso': '2026-06-25T00:00:00.000Z',
            'worktreeId': 'wt1',
            'branchName': 'main',
            'prUrl': null,
            'authorName': 'Sergii I.',
            'status': 'SUCCESS',
            'eventType': 'WORKTREE_CHAT',
            'durationMs': 271000,
            'inputTokens': 19200,
            'outputTokens': 4096,
          },
        ],
      };

      final usage = TeamUsageResponse.fromJson(json);
      expect(usage.scope, TelemetryUsageScope.organization);
      expect(usage.range.granularity, TelemetryTimeGranularity.day);
      expect(usage.headline, hasLength(2));
      expect(usage.headline.first.unit, TelemetryCardUnit.currency);
      expect(usage.headline.first.value, 8700.0);
      expect(usage.headline[1].value, 5959.0);
      expect(usage.headline[1].previousValue, isNull);
      // Regression guard for the protocol drift that broke stats loading:
      // the server now sends session-grouped expensive runs (sessionId +
      // turnCount) with no turnId. A non-empty list must round-trip cleanly.
      expect(usage.mostExpensiveRuns, hasLength(1));
      expect(usage.mostExpensiveRuns.first.sessionId, 'wt1:r1');
      expect(usage.mostExpensiveRuns.first.turnCount, 5);
      expect(usage.mostExpensiveRuns.first.totalCostUsd, 133.95);
      expect(usage.mostExpensiveRuns.first.prUrl, isNull);
      // The 2026-08-13 recurrence: the guard above covered only the row type
      // that broke in July and left `byUser` empty, so seven new required
      // fields on the leaderboard row sailed through. Keep these populated.
      expect(usage.byUser, hasLength(1));
      expect(usage.byUser.first.impactScore, 12.5);
      expect(usage.byUser.first.deliveryImpactRaw, 1.5);
      expect(usage.impactByUser, hasLength(1));
      expect(usage.impactByUser.first.key, 'Ada L.');
    });
  });

  group('AuthSession.fromSignInJson', () {
    test('parses a valid sign-in response', () {
      final session = AuthSession.fromSignInJson(<String, dynamic>{
        'token': 'tok-abc',
        'user': <String, dynamic>{'id': 'u1'},
      });
      expect(session.token, 'tok-abc');
      expect(session.user.id, 'u1');
    });

    test('throws FormatException when token is missing', () {
      expect(
        () => AuthSession.fromSignInJson(<String, dynamic>{
          'user': <String, dynamic>{'id': 'u1'},
        }),
        throwsFormatException,
      );
    });

    test('throws FormatException when token is not a string', () {
      expect(
        () => AuthSession.fromSignInJson(<String, dynamic>{
          'token': 123,
          'user': <String, dynamic>{'id': 'u1'},
        }),
        throwsFormatException,
      );
    });

    test('throws FormatException when user is missing or not an object', () {
      expect(
        () => AuthSession.fromSignInJson(<String, dynamic>{'token': 'tok'}),
        throwsFormatException,
      );
      expect(
        () => AuthSession.fromSignInJson(<String, dynamic>{
          'token': 'tok',
          'user': 'not-an-object',
        }),
        throwsFormatException,
      );
    });
  });
}
