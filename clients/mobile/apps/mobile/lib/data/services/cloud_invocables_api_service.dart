import 'dart:convert';

import 'package:mobile/data/models/cloud_invocables.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/cloud_api_service.dart';

/// The cloud slash-invocation inventories and the capability write that
/// enables an "Available to enable" row.
final class CloudInvocablesApiService {
  const CloudInvocablesApiService({required this.apiClient});

  final ApiClient apiClient;

  Future<T> _request<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on ApiException catch (error) {
      throw CloudApiException.fromApiException(error);
    }
  }

  /// `GET /api/cloud/chats/{chatId}/invocables`.
  Future<CloudInvocableInventory> chatInvocables(
    String chatId, {
    String? modelDefinitionId,
  }) async {
    final json = await _request(
      () => apiClient.getJson(
        '$cloudBasePath/chats/${Uri.encodeComponent(chatId)}/invocables',
        query: {
          'contractVersion': kCloudInvocablesContractVersion,
          'modelDefinitionId': ?modelDefinitionId,
        },
        retryTransient: false,
      ),
    );
    return CloudInvocableInventory.fromJson(json);
  }

  /// `GET /api/cloud/workspaces/{workspaceId}/invocables`, the inventory
  /// before a chat exists. [pluginSelections] replaces the project defaults
  /// when the draft has chosen its own.
  Future<CloudInvocableInventory> workspaceInvocables(
    String workspaceId, {
    String? modelDefinitionId,
    Map<String, Object?>? pluginSelections,
  }) async {
    final json = await _request(
      () => apiClient.getJson(
        '$cloudBasePath/workspaces/${Uri.encodeComponent(workspaceId)}'
        '/invocables',
        query: {
          'contractVersion': kCloudInvocablesContractVersion,
          'modelDefinitionId': ?modelDefinitionId,
          if (pluginSelections != null)
            'pluginSelections': jsonEncode(pluginSelections),
        },
        retryTransient: false,
      ),
    );
    return CloudInvocableInventory.fromJson(json, workspace: true);
  }

  /// `GET /api/cloud/capabilities/catalog?workspaceId=`: what the chats of
  /// [workspaceId] can select. The answer wraps the catalog with its version
  /// and marketplace flag.
  Future<ComposerPluginCatalog> capabilityCatalog(String workspaceId) async {
    final json = await _request(
      () => apiClient.getJson(
        '$cloudBasePath/capabilities/catalog',
        query: {'workspaceId': workspaceId},
        retryTransient: false,
      ),
    );
    return ComposerPluginCatalog.fromJson(json['catalog']);
  }

  /// `PUT /api/cloud/chats/{chatId}/capabilities` with the chat's complete
  /// desired selection. Answers what the chat holds once the server has
  /// accepted it.
  Future<CloudCapabilityWriteResult> setChatCapabilities(
    String chatId,
    Map<String, Object?> pluginSelections,
  ) async {
    final json = await _request(
      () => apiClient.putJson(
        '$cloudBasePath/chats/${Uri.encodeComponent(chatId)}/capabilities',
        body: {'pluginSelections': pluginSelections},
      ),
    );
    return CloudCapabilityWriteResult.fromJson(json);
  }
}
