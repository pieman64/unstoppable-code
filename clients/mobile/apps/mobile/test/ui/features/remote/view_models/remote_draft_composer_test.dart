import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/remote/view_models/remote_draft_composer.dart';

const _sonnet = ModelOption(
  id: 'claude-sonnet',
  label: 'Claude Sonnet',
  provider: 'claude',
  kind: 'model',
  available: true,
  isDefault: true,
);
const _codex = ModelOption(
  id: 'gpt-5-codex',
  label: 'GPT-5 Codex',
  provider: 'codex',
  kind: 'model',
  available: true,
);

RemoteChatSummary _chat(
  String id, {
  String worktree = 'wt-1',
  bool active = false,
  String? lastMessageAt,
  String? model,
  String? thinkingLevel,
}) => RemoteChatSummary.fromJson({
  'chatId': id,
  'scope': 'worktree',
  'workspaceLocalId': 'ws-1',
  'worktreeLocalId': worktree,
  'title': id,
  'active': active,
  'lastMessageAt': ?lastMessageAt,
  'model': ?model,
  'thinkingLevel': ?thinkingLevel,
});

RemoteDraftReference _reference({
  String? model,
  String? modelLabel,
  String? providerType,
  String? thinkingLevel,
  bool? planMode,
  bool? fastMode,
}) => (
  model: model,
  modelLabel: modelLabel,
  providerType: providerType,
  thinkingLevel: thinkingLevel,
  planMode: planMode,
  fastMode: fastMode,
  availableModels: const [],
  hasProjectedModelCatalog: false,
  providerAvailability: null,
);

void main() {
  group('reference chats (CAN-2932)', () {
    test('a code project starts beside its active chat, else its newest', () {
      final summaries = [
        _chat('older', lastMessageAt: '2026-10-01T00:00:00Z', model: 'a'),
        _chat('newer', lastMessageAt: '2026-10-20T00:00:00Z', model: 'b'),
        _chat('other-worktree', worktree: 'wt-2', active: true, model: 'c'),
      ];
      expect(
        remoteDraftWorktreeReference(
          summaries,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        )?.model,
        'b',
      );
      expect(
        remoteDraftWorktreeReference(
          [...summaries, _chat('active', active: true, model: 'd')],
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        )?.model,
        'd',
      );
      expect(
        remoteDraftWorktreeReference(summaries, workspaceLocalId: 'ws-2'),
        isNull,
      );
    });

    test('a Cowork project starts beside its latest unarchived chat', () {
      final reference = remoteDraftCoworkReference(const [
        RemoteStandaloneChat(
          localId: 'cc-1',
          projectLocalId: 'ws-notes',
          title: 'Old',
          lastMessageAt: '2026-10-01T00:00:00Z',
          model: 'old',
        ),
        RemoteStandaloneChat(
          localId: 'cc-2',
          projectLocalId: 'ws-notes',
          title: 'Archived',
          lastMessageAt: '2026-10-30T00:00:00Z',
          model: 'archived',
          archived: true,
        ),
        RemoteStandaloneChat(
          localId: 'cc-3',
          projectLocalId: 'ws-notes',
          title: 'New',
          lastMessageAt: '2026-10-20T00:00:00Z',
          model: 'new',
        ),
      ]);
      expect(reference?.model, 'new');
    });
  });

  group('remoteDraftModelCatalog (CAN-2932)', () {
    test('an explicitly empty owner catalog does not borrow other models', () {
      final reference = remoteDraftWorktreeReference([
        RemoteChatSummary.fromJson({
          'chatId': 'owner-chat',
          'scope': 'worktree',
          'workspaceLocalId': 'ws-1',
          'worktreeLocalId': 'wt-1',
          'title': 'Owner chat',
          'availableModels': <Object?>[],
        }),
      ], workspaceLocalId: 'ws-1');
      expect(
        remoteDraftModelCatalog(
          reference: reference,
          projected: const [_sonnet],
          projectedAvailability: null,
          standaloneChats: const [
            RemoteStandaloneChat(
              localId: 'other-chat',
              projectLocalId: 'other-owner',
              title: 'Other owner',
              availableModels: [_codex],
            ),
          ],
        ).models,
        isEmpty,
      );
    });

    test(
      'Cowork also preserves an explicitly empty catalog through projection',
      () {
        final chat = RemoteStandaloneChat.fromJson({
          'localId': 'owner-chat',
          'projectLocalId': 'owner-project',
          'title': 'Owner chat',
          'availableModels': <Object?>[],
        }).withEntryActivity(active: true, unread: false);
        final reference = remoteDraftCoworkReference([chat]);
        expect(
          remoteDraftModelCatalog(
            reference: reference,
            projected: const [_sonnet],
            projectedAvailability: null,
            standaloneChats: const [],
          ).models,
          isEmpty,
        );
      },
    );

    test('a missing reference catalog still uses the projected catalog', () {
      final reference = remoteDraftWorktreeReference([
        _chat('no-catalog'),
      ], workspaceLocalId: 'ws-1');
      expect(
        remoteDraftModelCatalog(
          reference: reference,
          projected: const [_sonnet],
          projectedAvailability: null,
          standaloneChats: const [],
        ).models,
        [_sonnet],
      );
    });

    test('prefers the reference chat\'s catalog, then the desktop\'s', () {
      final withReference = remoteDraftModelCatalog(
        reference: (
          model: null,
          modelLabel: null,
          providerType: null,
          thinkingLevel: null,
          planMode: null,
          fastMode: null,
          availableModels: const [_codex],
          hasProjectedModelCatalog: true,
          providerAvailability: null,
        ),
        projected: const [_sonnet],
        projectedAvailability: null,
        standaloneChats: const [],
      );
      expect(withReference.models, [_codex]);
      expect(
        remoteDraftModelCatalog(
          reference: null,
          projected: const [_sonnet],
          projectedAvailability: null,
          standaloneChats: const [],
        ).models,
        [_sonnet],
      );
    });

    test('falls back to a Cowork chat\'s catalog, and is empty without '
        'one', () {
      const carrier = RemoteStandaloneChat(
        localId: 'cc-1',
        projectLocalId: 'ws-notes',
        title: 'Notes',
        availableModels: [_codex],
      );
      expect(
        remoteDraftModelCatalog(
          reference: null,
          projected: const [],
          projectedAvailability: null,
          standaloneChats: const [carrier],
        ).models,
        [_codex],
      );
      expect(
        remoteDraftModelCatalog(
          reference: null,
          projected: const [],
          projectedAvailability: null,
          standaloneChats: const [],
        ).models,
        isEmpty,
      );
    });
  });

  group('RemoteDraftComposer (CAN-2932)', () {
    const catalog = [_sonnet, _codex];

    RemoteDraftComposer composer({
      RemoteDraftComposerChoices choices = const RemoteDraftComposerChoices(),
      RemoteDraftReference? reference,
      bool cowork = false,
    }) => RemoteDraftComposer(
      choices: choices,
      reference: reference,
      catalog: catalog,
      cowork: cowork,
    );

    test('seeds from the reference chat', () {
      final seeded = composer(
        reference: _reference(
          model: 'gpt-5-codex',
          thinkingLevel: 'medium',
          planMode: true,
          fastMode: true,
        ),
      );
      expect(seeded.selectedModel, _codex);
      expect(seeded.modelLabel, 'GPT-5 Codex');
      expect(seeded.effort.level, 'medium');
      expect(seeded.planMode, isTrue);
      expect(seeded.fastMode, isTrue);
      final options = seeded.sendOptions()!;
      expect(options.model, 'gpt-5-codex');
      expect(options.providerType, 'codex');
      expect(options.thinkingLevel, 'medium');
      expect(options.planMode, isTrue);
      expect(options.fastMode, isTrue);
    });

    test('names a reference model the catalog lacks by its label', () {
      final seeded = composer(
        reference: _reference(
          model: 'gpt-6.1-sol',
          modelLabel: 'GPT 6.1 Sol',
          providerType: 'codex',
        ),
      );
      expect(seeded.selectedModel, isNull);
      expect(seeded.modelLabel, 'GPT 6.1 Sol');
      expect(seeded.providerType, 'codex');
      expect(seeded.sendOptions()?.model, 'gpt-6.1-sol');
    });

    test('the user\'s choices win over the reference chat', () {
      final chosen = composer(
        reference: _reference(model: 'gpt-5-codex', thinkingLevel: 'low'),
        choices: const RemoteDraftComposerChoices(
          model: 'claude-sonnet',
          thinkingLevel: 'max',
          planMode: false,
        ),
      );
      expect(chosen.modelLabel, 'Claude Sonnet');
      expect(chosen.sendOptions()?.model, 'claude-sonnet');
      expect(chosen.sendOptions()?.planMode, isFalse);
    });

    test('a code project without a reference chat shows the catalog default '
        'at High and sends no model', () {
      final fresh = composer();
      expect(fresh.modelLabel, 'Claude Sonnet');
      expect(fresh.effort.level, 'high');
      final options = fresh.sendOptions()!;
      expect(options.model, isNull);
      expect(options.thinkingLevel, 'high');
      expect(options.planMode, isFalse);
    });

    test('a Cowork chat sends thinking and Fast only once touched, and no '
        'Plan', () {
      final untouched = composer(cowork: true);
      expect(untouched.effort.level, 'off');
      expect(untouched.sendOptions(), isNull);
      final touched = composer(
        cowork: true,
        choices: const RemoteDraftComposerChoices(
          model: 'gpt-5-codex',
          thinkingLevel: 'high',
          fastMode: true,
          planMode: true,
        ),
      ).sendOptions(inputMode: 'voice')!;
      expect(touched.model, 'gpt-5-codex');
      expect(touched.thinkingLevel, 'high');
      expect(touched.fastMode, isTrue);
      expect(touched.planMode, isNull);
      expect(touched.inputMode, 'voice');
    });
  });
}
