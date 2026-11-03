import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/workspace_context.dart';

void main() {
  group('RemoteWorkspace saved order', () {
    for (final value in [0, -2, 1.5]) {
      test('retains numeric order $value', () {
        expect(RemoteWorkspace.fromJson({'order': value}).order, value);
      });
    }
    for (final value in [null, '2', true, double.nan, double.infinity]) {
      test('ignores invalid order $value', () {
        expect(RemoteWorkspace.fromJson({'order': value}).order, isNull);
      });
    }
    test('accepts omitted order', () {
      expect(RemoteWorkspace.fromJson({}).order, isNull);
    });
  });

  group('RemoteWorkspaceType.fromWire', () {
    test('parses each known wire value', () {
      expect(
        RemoteWorkspaceType.fromWire('single-repo'),
        RemoteWorkspaceType.singleRepo,
      );
      expect(
        RemoteWorkspaceType.fromWire('multi-repo'),
        RemoteWorkspaceType.multiRepo,
      );
      expect(
        RemoteWorkspaceType.fromWire('cowork'),
        RemoteWorkspaceType.cowork,
      );
    });

    test('degrades null for unknown/absent values', () {
      expect(RemoteWorkspaceType.fromWire(null), isNull);
      expect(RemoteWorkspaceType.fromWire('brand-new-type'), isNull);
    });
  });

  group('RemoteWorktreePipelineStatus.fromWire', () {
    test('parses known values and degrades null for unknown/absent', () {
      expect(
        RemoteWorktreePipelineStatus.fromWire('running'),
        RemoteWorktreePipelineStatus.running,
      );
      expect(RemoteWorktreePipelineStatus.fromWire(null), isNull);
      expect(RemoteWorktreePipelineStatus.fromWire('who-knows'), isNull);
    });
  });

  group('RemoteWorkspace layout', () {
    RemoteWorkspace parse(Map<String, dynamic> json) =>
        RemoteWorkspace.fromJson({'localId': 'ws-1', 'name': 'A', ...json});

    test('parses the explicit layout axis', () {
      expect(
        parse({'type': 'cowork', 'layout': 'tree'}).resolvedLayout,
        RemoteWorkspaceLayout.tree,
      );
      expect(
        parse({'type': 'single-repo', 'layout': 'flat'}).resolvedLayout,
        RemoteWorkspaceLayout.flat,
      );
      expect(parse({'layout': 'wobbly'}).layout, isNull);
    });

    test('falls back to the legacy cowork→flat rule without layout', () {
      expect(
        parse({'type': 'cowork'}).resolvedLayout,
        RemoteWorkspaceLayout.flat,
      );
      expect(
        parse({'type': 'single-repo'}).resolvedLayout,
        RemoteWorkspaceLayout.tree,
      );
      expect(
        parse({'type': 'multi-repo'}).resolvedLayout,
        RemoteWorkspaceLayout.tree,
      );
    });
  });

  group('CAN-4429 RemoteWorkspace owner', () {
    WorkspaceContext? ownerOf(Object? owner, {bool include = true}) =>
        RemoteWorkspace.fromJson({
          'localId': 'ws-1',
          'name': 'Repo',
          'type': 'single-repo',
          if (include) 'owner': owner,
        }).ownerContext;

    test('a missing or null owner is legacy Personal', () {
      expect(ownerOf(null, include: false), const WorkspaceContext.personal());
      expect(ownerOf(null), const WorkspaceContext.personal());
    });

    test('parses all three owner kinds', () {
      expect(ownerOf({'type': 'personal'}), const WorkspaceContext.personal());
      expect(
        ownerOf({
          'type': 'organization',
          'organizationId': 'org-a',
          'projectId': 'project-1',
        }),
        const WorkspaceContext.organization('org-a'),
      );
      expect(
        ownerOf({'type': 'cloud-organization', 'organizationId': 'org-a'}),
        const WorkspaceContext.organization('org-a'),
      );
    });

    test('a malformed owner belongs to no context, not Personal', () {
      for (final owner in <Object>[
        'personal',
        42,
        const <String, dynamic>{},
        {'type': 'team', 'organizationId': 'org-a'},
        {'type': 'organization'},
        {'type': 'organization', 'organizationId': ''},
        {'type': 'cloud-organization', 'organizationId': 7},
      ]) {
        expect(ownerOf(owner), isNull, reason: '$owner');
      }
    });

    test('marks catalog placeholders', () {
      final placeholder = RemoteWorkspace.fromJson({
        'localId': 'ws-1',
        'name': 'Repo',
        'type': 'single-repo',
        'placeholder': {'projectId': 'project-1', 'state': 'available'},
      });
      final local = RemoteWorkspace.fromJson({
        'localId': 'ws-2',
        'name': 'Repo',
        'type': 'single-repo',
      });
      expect(placeholder.placeholder, isTrue);
      expect(local.placeholder, isFalse);
    });
  });

  group('RemoteWorkspace visibility flags', () {
    test('parses temporary/hidden/alwaysShow with wire-omitted defaults', () {
      final flagged = RemoteWorkspace.fromJson({
        'localId': 'ws-1',
        'name': 'Temp combine',
        'type': 'multi-repo',
        'temporary': true,
        'hidden': true,
        'alwaysShow': false,
      });
      expect(flagged.temporary, isTrue);
      expect(flagged.hidden, isTrue);
      expect(flagged.alwaysShow, isFalse);

      // The desktop omits all three when default.
      final plain = RemoteWorkspace.fromJson({
        'localId': 'ws-2',
        'name': 'Regular',
        'type': 'single-repo',
      });
      expect(plain.temporary, isFalse);
      expect(plain.hidden, isFalse);
      expect(plain.alwaysShow, isTrue);
    });
  });

  group('RemoteWorktree saved order', () {
    test('retains finite numeric positions and ignores malformed values', () {
      for (final value in <Object?>[
        -2,
        0,
        1.5,
        null,
        '2',
        true,
        {},
        double.nan,
        double.infinity,
        double.negativeInfinity,
      ]) {
        final worktree = RemoteWorktree.fromJson({
          'localId': 'wt',
          'workspaceLocalId': 'ws',
          'branch': 'main',
          'order': value,
        });
        expect(worktree.order, value is num && value.isFinite ? value : null);
      }
      expect(RemoteWorktree.fromJson({'localId': 'wt'}).order, isNull);
    });
  });

  group('notification space ids (CAN-3615)', () {
    test('worktree reads notificationSpaceId and keeps it on copies', () {
      final worktree = RemoteWorktree.fromJson({
        'localId': 'wt',
        'workspaceLocalId': 'ws',
        'branch': 'main',
        'notificationSpaceId': 'space-1',
      });
      expect(worktree.notificationSpaceId, 'space-1');
      expect(worktree.withUnread(true).notificationSpaceId, 'space-1');
      for (final value in <Object?>[null, '', 7, true, {}]) {
        expect(
          RemoteWorktree.fromJson({
            'localId': 'wt',
            'notificationSpaceId': value,
          }).notificationSpaceId,
          isNull,
        );
      }
      expect(
        RemoteWorktree.fromJson({'localId': 'wt'}).notificationSpaceId,
        isNull,
      );
    });

    test('standalone chat reads workEntryNotificationSpaceId and keeps it '
        'on entry rows', () {
      final chat = RemoteStandaloneChat.fromJson({
        'localId': 'chat-1',
        'projectLocalId': 'default',
        'workEntryId': 'entry-1',
        'workEntryNotificationSpaceId': 'space-entry-1',
      });
      expect(chat.workEntryNotificationSpaceId, 'space-entry-1');
      expect(
        chat
            .withEntryActivity(active: true, unread: false)
            .workEntryNotificationSpaceId,
        'space-entry-1',
      );
      for (final value in <Object?>[null, '', 3, false]) {
        expect(
          RemoteStandaloneChat.fromJson({
            'localId': 'chat-1',
            'workEntryNotificationSpaceId': value,
          }).workEntryNotificationSpaceId,
          isNull,
        );
      }
    });
  });

  group('RemoteWorktree diff/PR parsing', () {
    test('parses diffStats and lastKnownPrStatus repos', () {
      final worktree = RemoteWorktree.fromJson({
        'localId': 'wt-1',
        'workspaceLocalId': 'ws-1',
        'branch': 'feature/x',
        'diffStats': {'insertions': 64, 'deletions': 2},
        'lastKnownPrStatus': {
          'repos': [
            {
              'repoId': 'r1',
              'repoName': 'api',
              'status': {
                'prNumber': 1304,
                'state': 'open',
                'unresolvedReviewThreadCount': 2,
              },
            },
            // Repos with no PR yet carry a null status and are dropped.
            {'repoId': 'r2', 'repoName': 'web', 'status': null},
          ],
          'lastCheckedAt': '2026-07-17T10:00:00Z',
        },
      });

      expect(worktree.insertions, 64);
      expect(worktree.deletions, 2);
      expect(worktree.prStatuses, hasLength(1));
      expect(worktree.prStatuses.single.prNumber, 1304);
      expect(worktree.prStatuses.single.state, 'open');
      expect(worktree.prStatuses.single.unresolvedReviewThreadCount, 2);
    });

    test('parses live PR merge progress with wire-compatible defaults', () {
      final merging = RemoteWorktree.fromJson({
        'localId': 'wt-1',
        'workspaceLocalId': 'ws-1',
        'branch': 'feature/x',
        'mergingPr': true,
        'mergePrPhase': 'waiting_mergeability',
      });
      expect(merging.mergingPr, isTrue);
      expect(merging.mergePrPhase, 'waiting_mergeability');
      expect(merging.mergeProgressLabel, 'Waiting for GitHub');

      final stalePhase = RemoteWorktree.fromJson({
        'localId': 'wt-2',
        'workspaceLocalId': 'ws-1',
        'branch': 'feature/y',
        'mergingPr': false,
        'mergePrPhase': 'merging',
      });
      expect(stalePhase.mergeProgressLabel, isNull);

      final olderDesktop = RemoteWorktree.fromJson({
        'localId': 'wt-3',
        'workspaceLocalId': 'ws-1',
        'branch': 'feature/z',
      });
      expect(olderDesktop.mergingPr, isFalse);
      expect(olderDesktop.mergePrPhase, isNull);
      expect(olderDesktop.mergeProgressLabel, isNull);
    });

    test('tolerates absent diff/PR fields', () {
      final worktree = RemoteWorktree.fromJson({
        'localId': 'wt-1',
        'workspaceLocalId': 'ws-1',
        'branch': 'main',
      });
      expect(worktree.insertions, isNull);
      expect(worktree.deletions, isNull);
      expect(worktree.prStatuses, isEmpty);
      expect(worktree.setupPhase, isNull);
    });

    test('parses the deferred-create setupPhase', () {
      final worktree = RemoteWorktree.fromJson({
        'localId': 'wt-1',
        'workspaceLocalId': 'ws-1',
        'branch': 'feature/x',
        'setupPhase': 'git-pending',
      });
      expect(worktree.setupPhase, RemoteWorktreeSetupPhase.gitPending);

      expect(
        RemoteWorktree.fromJson({
          'localId': 'wt-1',
          'workspaceLocalId': 'ws-1',
          'branch': 'feature/x',
          'setupPhase': 'some-future-phase',
        }).setupPhase,
        isNull,
      );
    });
  });

  group('RemoteSessionSnapshot.fromJson', () {
    test('round-trips a fully-populated payload', () {
      final snapshot = RemoteSessionSnapshot.fromJson({
        'workspaces': [
          {
            'localId': 'ws-1',
            'name': 'app',
            'type': 'multi-repo',
            'rootPath': '/tmp/app',
            'color': '#1a2b3c',
            'repos': [
              {'id': 'r1', 'name': 'api', 'repoPath': 'packages/api'},
            ],
          },
        ],
        'worktrees': [
          {
            'localId': 'wt-1',
            'workspaceLocalId': 'ws-1',
            'branch': 'main',
            'label': 'Main',
            'status': 'idle',
            'busy': true,
            'hasUnread': false,
            'awaitingApproval': true,
            'pipelineStatus': 'unseen',
            'lastActivityAt': '2026-07-09T00:00:00Z',
          },
        ],
        'standaloneChats': [
          {
            'localId': 'chat-1',
            'projectLocalId': 'ws-1',
            'title': 'Hello',
            'modelLabel': 'Claude',
            'lastMessageAt': '2026-07-09T00:00:00Z',
            'providerType': 'claude',
            'archived': false,
          },
        ],
      });

      final ws = snapshot.workspaces.single;
      expect(ws.type, RemoteWorkspaceType.multiRepo);
      expect(ws.repos?.single.name, 'api');
      final wt = snapshot.worktrees.single;
      expect(wt.pipelineStatus, RemoteWorktreePipelineStatus.unseen);
      expect(wt.awaitingApproval, isTrue);
      expect(snapshot.standaloneChats.single.providerType, 'claude');
    });

    test('parses rows with all optional fields absent', () {
      // Only the required (non-null) wire fields are present. This documents
      // the required-vs-optional contract and guards against a future change
      // that accidentally makes an optional field required.
      final snapshot = RemoteSessionSnapshot.fromJson({
        'workspaces': [
          {'localId': 'ws-1', 'name': 'app', 'type': 'single-repo'},
        ],
        'worktrees': [
          {'localId': 'wt-1', 'workspaceLocalId': 'ws-1', 'branch': 'main'},
        ],
        'standaloneChats': [
          {'localId': 'chat-1', 'projectLocalId': 'ws-1', 'title': 'Hi'},
        ],
      });

      final ws = snapshot.workspaces.single;
      expect(ws.type, RemoteWorkspaceType.singleRepo);
      expect(ws.rootPath, isNull);
      expect(ws.color, isNull);
      expect(ws.repos, isNull);
      final wt = snapshot.worktrees.single;
      expect(wt.label, isNull);
      expect(wt.pipelineStatus, isNull);
      expect(wt.busy, isNull);
      expect(snapshot.standaloneChats.single.modelLabel, isNull);
    });

    test('defaults each collection to empty when the key is absent', () {
      final snapshot = RemoteSessionSnapshot.fromJson(const {});

      expect(snapshot.workspaces, isEmpty);
      expect(snapshot.worktrees, isEmpty);
      expect(snapshot.standaloneChats, isEmpty);
    });

    test('degrades malformed rows without throwing TypeError', () {
      final snapshot = RemoteSessionSnapshot.fromJson({
        'workspaces': [
          {
            'localId': null,
            'name': null,
            'type': 'brand-new-type',
            'rootPath': 42,
            'color': false,
            'repos': [
              {'id': null, 'name': null, 'repoPath': null},
              'not-a-repo',
            ],
          },
        ],
        'worktrees': [
          {
            'localId': null,
            'workspaceLocalId': null,
            'branch': null,
            'busy': 'yes',
            'pipelineStatus': 42,
          },
        ],
        'standaloneChats': [
          {
            'localId': null,
            'projectLocalId': null,
            'title': null,
            'archived': 'no',
          },
        ],
      });

      final ws = snapshot.workspaces.single;
      expect(ws.localId, '');
      expect(ws.name, 'Untitled project');
      expect(ws.type, isNull);
      expect(ws.rootPath, isNull);
      expect(ws.color, isNull);
      expect(ws.repos?.single.name, 'Repository');

      final wt = snapshot.worktrees.single;
      expect(wt.localId, '');
      expect(wt.workspaceLocalId, '');
      expect(wt.branch, 'Detached worktree');
      expect(wt.busy, isNull);
      expect(wt.pipelineStatus, isNull);

      final chat = snapshot.standaloneChats.single;
      expect(chat.localId, '');
      expect(chat.projectLocalId, '');
      expect(chat.title, 'Untitled chat');
      expect(chat.archived, isNull);
    });
  });

  group('RemoteStandaloneChat composer state', () {
    test('preserves entry identity and resolves display titles', () {
      final chat = RemoteStandaloneChat.fromJson({
        'localId': 'chat-1',
        'projectLocalId': 'default',
        'title': 'ping',
        'description': 'Network connectivity test',
        'workEntryId': 'entry-1',
        'workEntryTitle': 'Explicit rename',
      });
      expect(chat.workEntryId, 'entry-1');
      expect(chat.title, 'ping');
      expect(chat.displayTitle, 'Explicit rename');
      expect(
        RemoteStandaloneChat.fromJson({
          'title': 'ping',
          'description': 'Network connectivity test',
        }).displayTitle,
        'Network connectivity test',
      );
      expect(
        RemoteStandaloneChat.fromJson({
          'title': 'ping',
          'description': '  ',
          'workEntryTitle': '',
        }).displayTitle,
        'ping',
      );
    });

    test('parses the selected model and projected catalog', () {
      final chat = RemoteStandaloneChat.fromJson({
        'localId': 'chat-arch',
        'projectLocalId': 'ws-notes',
        'title': 'Weekly planning',
        'providerType': 'claude',
        'model': 'claude-sonnet',
        'providerAvailability': {'claude': true},
        'availableModels': [
          {
            'id': 'claude-sonnet',
            'label': 'Claude Sonnet 4.5',
            'provider': 'claude',
            'kind': 'model',
            'available': true,
          },
        ],
      });

      expect(chat.model, 'claude-sonnet');
      expect(chat.providerAvailability?.isAvailable('claude'), isTrue);
      expect(chat.availableModels.single.id, 'claude-sonnet');
    });

    test('composer state is absent by default', () {
      final chat = RemoteStandaloneChat.fromJson({
        'localId': 'c',
        'projectLocalId': 'p',
        'title': 'T',
      });
      expect(chat.model, isNull);
      expect(chat.providerAvailability, isNull);
      expect(chat.availableModels, isEmpty);
      expect(chat.pluginSelectionsDetail, isNull);
    });

    test('CAN-3925 keeps the projected plugin selection through activity '
        'copies, and an empty one stays distinct from none', () {
      final chat = RemoteStandaloneChat.fromJson({
        'localId': 'c',
        'projectLocalId': 'p',
        'title': 'T',
        'pluginSelectionsDetail': {
          'collectionIds': ['kit'],
          'pluginRefs': [
            {'marketplaceId': 'm', 'pluginName': 'github'},
          ],
        },
      });
      expect(chat.pluginSelectionsDetail, {
        'collectionIds': ['kit'],
        'pluginRefs': [
          {'marketplaceId': 'm', 'pluginName': 'github'},
        ],
      });
      expect(
        chat
            .withEntryActivity(active: true, unread: true)
            .pluginSelectionsDetail,
        chat.pluginSelectionsDetail,
      );
      final empty = RemoteStandaloneChat.fromJson({
        'localId': 'c',
        'projectLocalId': 'p',
        'title': 'T',
        'pluginSelectionsDetail': <String, Object?>{},
      });
      expect(empty.pluginSelectionsDetail, isEmpty);
      expect(
        RemoteStandaloneChat.fromJson({
          'localId': 'c',
          'projectLocalId': 'p',
          'title': 'T',
          'pluginSelectionsDetail': 'bad',
        }).pluginSelectionsDetail,
        isNull,
      );
    });
  });

  group('PR check list (CAN-3618)', () {
    test('a PR refresh keeps every check in host order', () {
      final repo = RemotePrRepo.fromJson({
        'repoId': 'repo-app',
        'repoName': 'App',
        'status': {
          'number': 42,
          'state': 'open',
          'checkStatus': 'failing',
          'checkDetails': [
            {
              'name': 'build',
              'status': 'pending',
              'executionState': 'running',
              'detailsUrl': 'https://github.com/acme/app/actions/runs/1',
            },
            {'name': 'legacy', 'status': 'success', 'detailsUrl': null},
            {'name': 'newer', 'status': 'neutral', 'executionState': 'paused'},
          ],
        },
      });

      final checks = repo.pr!.checks;
      expect(checks.map((check) => check.name), ['build', 'legacy', 'newer']);
      expect(checks[0].status, 'pending');
      expect(checks[0].executionState, 'running');
      expect(
        checks[0].detailsUri,
        Uri.parse('https://github.com/acme/app/actions/runs/1'),
      );
      expect(checks[1].executionState, isNull);
      expect(checks[1].detailsUri, isNull);
      // Unknown values are kept for the display layer to degrade.
      expect(checks[2].executionState, 'paused');
    });

    test('skips malformed entries without losing their siblings', () {
      final pr = RemoteWorktreePr.fromPortal({
        'state': 'open',
        'checkDetails': [
          'not a check',
          {'status': 'success'},
          {'name': '', 'status': 'success'},
          {'name': 'odd', 'status': 7, 'executionState': false},
          {'name': 'lint', 'status': 'success', 'executionState': 'success'},
        ],
      });

      expect(pr.checks.map((check) => check.name), ['odd', 'lint']);
      expect(pr.checks.first.status, isNull);
      expect(pr.checks.first.executionState, isNull);
    });

    test('only keeps absolute web links', () {
      Uri? linkFor(Object? url) => RemoteWorktreePr.fromPortal({
        'state': 'open',
        'checkDetails': [
          {'name': 'check', 'status': 'failure', 'detailsUrl': url},
        ],
      }).checks.single.detailsUri;

      expect(linkFor('http://ci.example.com/1'), isNotNull);
      expect(linkFor(' https://ci.example.com/1 '), isNotNull);
      expect(linkFor('javascript:alert(1)'), isNull);
      expect(linkFor('/job/1'), isNull);
      expect(linkFor('https://'), isNull);
      expect(linkFor('mailto:ci@example.com'), isNull);
      expect(linkFor(42), isNull);
      expect(linkFor(null), isNull);
    });

    test('a missing, empty or malformed list has no checks', () {
      for (final details in <Object?>[null, const <Object?>[], 'checks', 3]) {
        final pr = RemoteWorktreePr.fromPortal({
          'state': 'open',
          'checkStatus': 'failing',
          'checkDetails': ?details,
        });
        expect(pr.checks, isEmpty, reason: '$details');
      }
    });

    test('the worktree summary never carries a check list', () {
      final worktree = RemoteWorktree.fromJson({
        'localId': 'wt-1',
        'workspaceLocalId': 'ws-1',
        'branch': 'feat/x',
        'lastKnownPrStatus': {
          'repos': [
            {
              'status': {
                'state': 'open',
                'prNumber': 42,
                'checkStatus': 'failing',
                'checkDetails': [
                  {'name': 'build', 'status': 'failing'},
                ],
              },
            },
          ],
        },
      });

      expect(worktree.prStatuses.single.checkStatus, 'failing');
      expect(worktree.prStatuses.single.checks, isEmpty);
    });
  });

  group('PR host-summary and live-observation reconciliation', () {
    for (final hasHostSummary in [false, true]) {
      test(
        'runtime rows retain live PR only with an empty host baseline, host=$hasHostSummary',
        () {
          const hostPr = RemoteWorktreePr(prNumber: 10, state: 'open');
          const livePr = RemoteWorktreePr(prNumber: 42, state: 'open');
          final host = hasHostSummary ? [hostPr] : <RemoteWorktreePr>[];
          final previous =
              RemoteWorktree(
                localId: 'wt',
                workspaceLocalId: 'ws',
                branch: 'feature',
                prStatuses: host,
              ).withPrStatuses([
                livePr,
              ], source: RemotePrObservationSource.actionRead);
          final incoming = RemoteWorktree(
            localId: 'wt',
            workspaceLocalId: 'ws',
            branch: 'feature',
            label: 'Updated activity',
            prStatuses: [...host],
          );
          final updated = incoming.inheritRuntimePr(previous);
          expect(updated.label, 'Updated activity');
          if (hasHostSummary) {
            expect(updated.prStatuses.single, same(hostPr));
          } else {
            expect(updated.prStatuses, same(previous.prStatuses));
            expect(updated.prStatuses.single, same(livePr));
          }
          // Removing the live observation still restores the host baseline.
          final removed = updated.withoutPrObservation();
          expect(
            incoming.inheritRuntimePr(removed).prStatuses,
            same(removed.prStatuses),
          );
          expect(
            removed.prStatuses.map((pr) => pr.prNumber),
            hasHostSummary ? [10] : isEmpty,
          );
        },
      );
    }
    test(
      'changed host baseline and incoming live observations remain authoritative',
      () {
        const hostPr = RemoteWorktreePr(prNumber: 10, state: 'open');
        const livePr = RemoteWorktreePr(prNumber: 42, state: 'open');
        const newerPr = RemoteWorktreePr(prNumber: 43, state: 'merged');
        final previous =
            const RemoteWorktree(
              localId: 'wt',
              workspaceLocalId: 'ws',
              branch: 'feature',
              prStatuses: [hostPr],
            ).withPrStatuses([
              livePr,
            ], source: RemotePrObservationSource.actionRead);
        const noHostSummary = RemoteWorktree(
          localId: 'wt',
          workspaceLocalId: 'ws',
          branch: 'feature',
        );
        final cleared = noHostSummary.inheritRuntimePr(previous);
        expect(cleared.prStatuses, isEmpty);
        final observed = noHostSummary.withPrStatuses([newerPr]);
        expect(
          observed
              .inheritRuntimePr(
                noHostSummary.withPrStatuses([
                  livePr,
                ], source: RemotePrObservationSource.actionRead),
              )
              .prStatuses
              .single,
          same(newerPr),
        );
      },
    );
  });

  group('widened PR projection', () {
    test(
      'parses widened PR status fields and normalizes reviewStatus none',
      () {
        final worktree = RemoteWorktree.fromJson({
          'localId': 'wt-1',
          'workspaceLocalId': 'ws-1',
          'branch': 'feat/x',
          'lastKnownPrStatus': {
            'repos': [
              {
                'status': {
                  'state': 'open',
                  'prNumber': 42,
                  'title': 'Add feature X',
                  'checkStatus': 'failing',
                  'reviewStatus': 'changes_requested',
                  'hasConflicts': true,
                  'commentCount': 3,
                },
              },
              {
                'status': {
                  'state': 'open',
                  'prNumber': 43,
                  'reviewStatus': 'none',
                },
              },
            ],
          },
        });
        final pr = worktree.prStatuses.first;
        expect(pr.title, 'Add feature X');
        expect(pr.checkStatus, 'failing');
        expect(pr.reviewStatus, 'changes-requested');
        expect(pr.hasConflicts, isTrue);
        expect(pr.commentCount, 3);
        final second = worktree.prStatuses[1];
        expect(second.reviewStatus, isNull);
        expect(second.title, isNull);
        expect(second.hasConflicts, isNull);
        expect(second.commentCount, isNull);
      },
    );
  });

  group('runtime aggregate statuses', () {
    test('parses worktree script/hook/terminal statuses', () {
      final worktree = RemoteWorktree.fromJson({
        'localId': 'wt-1',
        'workspaceLocalId': 'ws-1',
        'branch': 'main',
        'scriptStatus': 'running',
        'hookStatus': 'running',
        'terminalStatus': 'unseen-failure',
      });
      expect(worktree.scriptStatus, 'running');
      expect(worktree.hookStatus, 'running');
      expect(worktree.terminalStatus, 'unseen-failure');
    });

    test('parses standalone hasActiveChat and hasUnread', () {
      final chat = RemoteStandaloneChat.fromJson({
        'localId': 'chat-1',
        'projectLocalId': 'proj-1',
        'title': 'Chat',
        'hasActiveChat': true,
        'hasUnread': true,
      });
      expect(chat.hasActiveChat, isTrue);
      expect(chat.hasUnread, isTrue);
    });

    test('aggregate statuses default to null when absent', () {
      final worktree = RemoteWorktree.fromJson({
        'localId': 'wt-1',
        'workspaceLocalId': 'ws-1',
        'branch': 'main',
      });
      expect(worktree.scriptStatus, isNull);
      expect(worktree.hookStatus, isNull);
      expect(worktree.terminalStatus, isNull);
    });

    test('isWorking derives from isStreaming or legacy busy', () {
      RemoteWorktree parse(Map<String, dynamic> extra) =>
          RemoteWorktree.fromJson({
            'localId': 'wt-1',
            'workspaceLocalId': 'ws-1',
            'branch': 'main',
            ...extra,
          });
      // Current desktops project isStreaming; older ones projected busy.
      expect(parse({'isStreaming': true}).isStreaming, isTrue);
      expect(parse({'isStreaming': true}).isWorking, isTrue);
      expect(parse({'busy': true}).isWorking, isTrue);
      expect(parse(const {}).isWorking, isFalse);
      expect(parse({'isStreaming': false, 'busy': false}).isWorking, isFalse);
    });

    test('parses the hidden flag when present', () {
      final worktree = RemoteWorktree.fromJson({
        'localId': 'wt-1',
        'workspaceLocalId': 'ws-1',
        'branch': 'main',
        'hidden': true,
      });
      expect(worktree.hidden, isTrue);
    });

    test('hidden is null when absent or malformed', () {
      final absent = RemoteWorktree.fromJson({
        'localId': 'wt-1',
        'workspaceLocalId': 'ws-1',
        'branch': 'main',
      });
      final malformed = RemoteWorktree.fromJson({
        'localId': 'wt-1',
        'workspaceLocalId': 'ws-1',
        'branch': 'main',
        'hidden': 'yes',
      });
      expect(absent.hidden, isNull);
      expect(malformed.hidden, isNull);
    });
  });
}
