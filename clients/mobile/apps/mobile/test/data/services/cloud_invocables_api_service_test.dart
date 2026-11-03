import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/data/services/cloud_invocables_api_service.dart';

CloudInvocablesApiService _service(
  Future<http.Response> Function(http.Request request) handler,
) => CloudInvocablesApiService(
  apiClient: ApiClient(
    baseUrl: 'https://example.test',
    tokenProvider: () => 'mobile-session',
    httpClient: MockClient(handler),
  ),
);

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status);

const _row = {
  'name': 'review',
  'description': 'Review changes',
  'insertText': '/review ',
};

void main() {
  test('reads a chat inventory for the selected model', () async {
    final service = _service((request) async {
      expect(request.method, 'GET');
      expect(request.url.path, '/api/cloud/chats/chat%2F1/invocables');
      expect(request.url.queryParameters, {
        'contractVersion': '2',
        'modelDefinitionId': 'gpt 5',
      });
      return _json({
        'rows': [_row],
      });
    });
    final inventory = await service.chatInvocables(
      'chat/1',
      modelDefinitionId: 'gpt 5',
    );
    expect(inventory.rows.single.name, 'review');
  });

  test('reads a project inventory with the draft selection', () async {
    final selections = {
      'collectionIds': <String>[],
      'skillRefs': [
        {'sourceId': 'src', 'skillName': 'notes'},
      ],
      'pluginRefs': <Object>[],
    };
    final queries = <Map<String, String>>[];
    final service = _service((request) async {
      expect(request.url.path, '/api/cloud/workspaces/ws-1/invocables');
      queries.add(request.url.queryParameters);
      return _json({
        'rows': [_row],
        'defaultPluginSelections': {
          'collectionIds': ['c1'],
        },
      });
    });
    final inventory = await service.workspaceInvocables(
      'ws-1',
      pluginSelections: selections,
    );
    await service.workspaceInvocables('ws-1', modelDefinitionId: 'm');
    expect(queries.first['contractVersion'], '2');
    expect(queries.first.containsKey('modelDefinitionId'), isFalse);
    expect(jsonDecode(queries.first['pluginSelections']!), selections);
    expect(queries.last, {'contractVersion': '2', 'modelDefinitionId': 'm'});
    expect(inventory.defaultPluginSelections, {
      'collectionIds': ['c1'],
    });
  });

  test('saves the complete chat selection', () async {
    final selections = {
      'collectionIds': ['c1'],
      'skillRefs': <Object>[],
      'pluginRefs': [
        {'marketplaceId': 'm', 'pluginName': 'p'},
      ],
    };
    final service = _service((request) async {
      expect(request.method, 'PUT');
      expect(request.url.path, '/api/cloud/chats/chat-1/capabilities');
      expect(jsonDecode(request.body), {'pluginSelections': selections});
      return _json({
        'capabilityBundles': <String, Object>{},
        'outcome': 'staged',
        'capabilitySelections': selections,
        'warnings': <String>[],
      });
    });
    final result = await service.setChatCapabilities('chat-1', selections);
    expect(result.selections, selections);
    expect(result.enables({'marketplaceId': 'm', 'pluginName': 'p'}), isTrue);
    expect(result.enables({'marketplaceId': 'm', 'pluginName': 'q'}), isFalse);
  });

  test('maps a failed request to a cloud error', () async {
    final service = _service(
      (_) async => _json({'error': 'pluginSelections is required'}, 400),
    );
    await expectLater(
      service.setChatCapabilities('chat-1', const {}),
      throwsA(
        isA<CloudApiException>().having((e) => e.statusCode, 'status', 400),
      ),
    );
  });

  test('CAN-3922 reads the workspace capability catalog', () async {
    final service = _service((request) async {
      expect(request.method, 'GET');
      expect(request.url.path, '/api/cloud/capabilities/catalog');
      expect(request.url.queryParameters, {'workspaceId': 'ws/1'});
      return _json({
        'version': 1,
        'marketplacesEnabled': true,
        'catalog': {
          'collections': <Object?>[],
          'skills': [
            {'sourceId': 'src', 'skillName': 'notes', 'name': 'Notes'},
          ],
          'plugins': <Object?>[],
          'mcpServers': <Object?>[],
        },
      });
    });
    final catalog = await service.capabilityCatalog('ws/1');
    expect(catalog.items.single.key, 'skill:src/notes');
  });

  test('CAN-3922 rejects a catalog answer without its catalog', () async {
    final service = _service((request) async => _json({'version': 1}));
    await expectLater(service.capabilityCatalog('ws-1'), throwsFormatException);
  });
}
