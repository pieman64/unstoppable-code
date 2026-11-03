import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/profile_api_service.dart';

void main() {
  test('updateName PATCHes the name and parses the response', () async {
    String? method;
    String? body;
    Uri? uri;
    final client = MockClient((req) async {
      method = req.method;
      body = req.body;
      uri = req.url;
      return http.Response(
        jsonEncode({'name': 'Ada Lovelace', 'image': null}),
        200,
      );
    });
    final service = ProfileApiService(
      apiClient: ApiClient(
        baseUrl: 'https://canopy.example.com',
        defaultHeaders: const {},
        httpClient: client,
      ),
    );

    final result = await service.updateName('Ada Lovelace');

    expect(method, 'PATCH');
    expect(uri?.path, '/api/account/profile');
    expect(jsonDecode(body!), {'name': 'Ada Lovelace'});
    expect(result.name, 'Ada Lovelace');
    expect(result.image, isNull);
  });
}
