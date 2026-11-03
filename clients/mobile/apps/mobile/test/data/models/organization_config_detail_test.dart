import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/organization.dart';

void main() {
  group('OrganizationConfigDetail.fromJson', () {
    test('parses the data-sharing switch, usage role, and scopes', () {
      final json = <String, dynamic>{
        'allowExternalContainerSharing': true,
        'blockedModelIds': <String>['openai/gpt-5'],
        'enforceMemberDataSharing': true,
        'enforceMemberModelGateway': true,
        'enforceMemberModelPolicy': true,
        'modelGatewayBaseUrl': 'https://gateway.example.com',
        'modelGatewayEnforced': true,
        'modelGatewayModels': <Map<String, dynamic>>[
          <String, dynamic>{
            'id': 'claude-sonnet',
            'gatewayId': 'anthropic/claude-sonnet-4-5',
            'label': 'Claude Sonnet',
            'harness': 'claude',
            'contextWindow': 200000,
            'supportedThinkingLevels': <String>['medium', 'high'],
            'toolSchemaProfile': 'standard',
          },
        ],
        'modelGatewayPromptCachePassthrough': false,
        'reviewedModelIds': <String>['openai/gpt-5', 'anthropic/claude-sonnet'],
        'usageStatsMinRole': 'ADMIN',
        'enforcedSync': <String, dynamic>{
          'transcripts': false,
          'plans': true,
          'metadata': null,
          'summaries': false,
        },
      };

      final config = OrganizationConfigDetail.fromJson(json);

      expect(config.allowExternalContainerSharing, isTrue);
      expect(config.blockedModelIds, <String>['openai/gpt-5']);
      expect(config.enforceMemberDataSharing, isTrue);
      expect(config.enforceMemberModelGateway, isTrue);
      expect(config.enforceMemberModelPolicy, isTrue);
      expect(config.modelGatewayBaseUrl, 'https://gateway.example.com');
      expect(config.modelGatewayEnforced, isTrue);
      expect(config.modelGatewayPromptCachePassthrough, isFalse);
      expect(config.modelGatewayModels, hasLength(1));
      expect(config.modelGatewayModels.single.id, 'claude-sonnet');
      expect(
        config.modelGatewayModels.single.gatewayId,
        'anthropic/claude-sonnet-4-5',
      );
      expect(config.modelGatewayModels.single.harness, AiGatewayHarness.claude);
      expect(config.modelGatewayModels.single.contextWindow, 200000);
      expect(
        config.modelGatewayModels.single.supportedThinkingLevels,
        <AiGatewayThinkingLevel>[
          AiGatewayThinkingLevel.medium,
          AiGatewayThinkingLevel.high,
        ],
      );
      expect(
        config.modelGatewayModels.single.toolSchemaProfile,
        AiGatewayToolSchemaProfile.standard,
      );
      expect(config.reviewedModelIds, <String>[
        'openai/gpt-5',
        'anthropic/claude-sonnet',
      ]);
      expect(config.usageStatsMinRole, OrganizationRole.admin);
      // Three-state: true = required, false = prohibited, null = unset.
      expect(config.enforcedSync.plans, isTrue);
      expect(config.enforcedSync.transcripts, isFalse);
      expect(config.enforcedSync.metadata, isNull);
      expect(config.enforcedSync.summaries, isFalse);
    });
  });
}
