import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:mobile/data/protocol/generated/organization.dart';

const int _maxReadRetries = 2;
const Duration _initialReadRetryDelay = Duration(milliseconds: 250);

Duration _readRetryDelay(int retryIndex) =>
    _initialReadRetryDelay * (1 << retryIndex);

bool _isTransientStatus(int statusCode) =>
    statusCode == 408 ||
    statusCode == 429 ||
    statusCode == 500 ||
    statusCode == 502 ||
    statusCode == 503 ||
    statusCode == 504;

bool _isTransientTransportError(Object error) =>
    error is http.ClientException || error is TimeoutException;

// Client-surface declaration for server-side product activity. These literals
// mirror the canonical TypeScript module,
// `packages/protocol/src/client-surface/index.ts`; change them there first.
// The server reads both headers as untrusted metadata, never as authorization.
const String clientSurfaceHeader = 'x-canopy-client';
const String clientSurfaceVersionHeader = 'x-canopy-client-version';
const String mobileClientSurface = 'mobile';

/// The version shape the server accepts. Anything else is dropped there, so
/// it is not sent.
final RegExp _clientVersionPattern = RegExp(r'^[0-9A-Za-z.+-]{1,32}$');

/// Thrown by [ApiClient] when the server returns a non-2xx status code.
final class ApiException implements Exception {
  const ApiException({
    required this.statusCode,
    required this.body,
    this.headers = const {},
  });

  final int statusCode;
  final String body;
  final Map<String, String> headers;

  @override
  String toString() => 'ApiException($statusCode): $body';
}

/// Extracts the server's `{error}` message from an [ApiException] body, when
/// present, for user-presentable copy.
///
/// Lives next to [ApiException] so any feature can surface a deliberate
/// server-authored reason (e.g. the 409 an organization delete returns while a
/// subscription is live) instead of swallowing it behind generic copy.
String? apiErrorMessage(ApiException exception) {
  try {
    final decoded = jsonDecode(exception.body);
    if (decoded is Map<String, dynamic>) {
      final error = decoded['error'];
      if (error is String && error.isNotEmpty) return error;
    }
  } catch (_) {
    // Non-JSON body.
  }
  return null;
}

/// The structured org-billing lapse payload when [exception] is the 403 the
/// web API returns after an organization loses its `teams` capability, else
/// null.
///
/// Keys off the `code` discriminator, never the message text: the same
/// endpoints return 403 for a plain permission refusal too (e.g.
/// `GET /organizations/{orgId}/usage` refuses both a lapsed org and a viewer
/// whose role is below `usageStatsMinRole`), and those must not be mistaken
/// for a lapse. Anything unexpected — non-403, non-JSON, non-map, missing or
/// unknown `code` — returns null so the caller falls back to generic copy.
OrgTeamsLapsedError? orgTeamsLapse(ApiException exception) {
  if (exception.statusCode != 403) return null;
  try {
    final decoded = jsonDecode(exception.body);
    if (decoded is! Map<String, dynamic>) return null;
    if (decoded['code'] != 'org_teams_lapsed') return null;
    if (decoded['error'] is! String) return null;
    return OrgTeamsLapsedError.fromJson(decoded);
  } catch (_) {
    // Non-JSON body, or a shape the generated model rejects.
    return null;
  }
}

/// [orgTeamsLapse] for an arbitrary caught [error], which is what view models
/// actually hold. Returns null for anything that is not the org-billing 403.
OrgTeamsLapsedError? errorOrgTeamsLapse(Object? error) =>
    error is ApiException ? orgTeamsLapse(error) : null;

/// User-presentable copy for an arbitrary caught [error], or null when there
/// is nothing honest to show.
///
/// Only 4xx bodies are surfaced: those carry deliberate, server-authored copy
/// aimed at the user (e.g. "You do not have permission to view usage
/// statistics"). A 5xx or a transport failure gets null so the caller falls
/// back to its own generic sentence — the server's words there describe an
/// internal fault, not something the user can act on.
///
/// Never returns `error.toString()`: [ApiException.toString] embeds the whole
/// raw response body, which is how a raw `ApiException(403): {...}` dump
/// reached the activity screen in the first place.
String? presentableErrorMessage(Object? error) {
  if (error is! ApiException) return null;
  if (error.statusCode < 400 || error.statusCode >= 500) return null;
  return apiErrorMessage(error);
}

/// Thin HTTP wrapper used by all API services.
///
/// Accepts an injectable [http.Client] so unit tests can substitute a
/// [MockClient] without hitting the network.  When [tokenProvider] is supplied
/// and returns a non-empty token, an `Authorization: Bearer` header is attached
/// to every request.
///
/// Read requests retry transient transport failures and 408, 429, 500, 502,
/// 503, and 504 responses up to twice, after 250 ms and 500 ms. Mutating
/// requests are never replayed automatically: these APIs do not share a
/// universal idempotency-key contract, so retrying a write after its response
/// was lost could apply the same action twice.
final class ApiClient {
  ApiClient({
    required String baseUrl,
    Map<String, String> defaultHeaders = const {},
    this.tokenProvider,
    this.twoFactorProofProvider,
    this.clientVersionProvider,
    http.Client? httpClient,
  }) : baseUrlProvider = (() => baseUrl),
       _defaultHeaders = Map.unmodifiable(defaultHeaders),
       _client = httpClient ?? http.Client();

  /// Creates a client whose origin is resolved immediately before each request.
  /// Used by the mobile runtime so changing its fixed API environment does not
  /// leave long-lived repositories pointing at the previous origin.
  ApiClient.withBaseUrlProvider({
    required this.baseUrlProvider,
    Map<String, String> defaultHeaders = const {},
    this.tokenProvider,
    this.twoFactorProofProvider,
    this.clientVersionProvider,
    http.Client? httpClient,
  }) : _defaultHeaders = Map.unmodifiable(defaultHeaders),
       _client = httpClient ?? http.Client();

  final String Function() baseUrlProvider;
  String get baseUrl => baseUrlProvider();
  final Map<String, String> _defaultHeaders;
  final String? Function()? tokenProvider;

  /// Supplies the mobile 2FA proof for 2FA-enabled users. When it returns a
  /// non-empty value, it is attached as the `x-two-factor-verified` header so
  /// bearer requests satisfy the shared two-factor gate.
  final String? Function()? twoFactorProofProvider;

  /// Supplies the app version for the `x-canopy-client-version` header. The
  /// header is omitted while this returns null (the platform read has not
  /// resolved) or a value outside the accepted shape.
  final String? Function()? clientVersionProvider;
  final http.Client _client;

  /// Copies this client's dynamic origin and auth configuration onto an
  /// independently owned transport. The caller owns and must close
  /// [httpClient].
  ApiClient withHttpClient(http.Client httpClient) =>
      ApiClient.withBaseUrlProvider(
        baseUrlProvider: baseUrlProvider,
        defaultHeaders: _defaultHeaders,
        tokenProvider: tokenProvider,
        twoFactorProofProvider: twoFactorProofProvider,
        clientVersionProvider: clientVersionProvider,
        httpClient: httpClient,
      );

  /// Issues a GET to [path] (relative to [baseUrl]) with any [query] params.
  /// Throws [ApiException] on any non-2xx response.
  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, String>? query,
    bool retryTransient = true,
  }) async {
    return getDecoded(
      path,
      query: query,
      retryTransient: retryTransient,
      decode: _decode,
    );
  }

  /// Reads through the normal authenticated/retried transport, then lets a
  /// typed decoder move expensive parsing off the calling isolate.
  Future<T> getDecoded<T>(
    String path, {
    Map<String, String>? query,
    bool retryTransient = true,
    required FutureOr<T> Function(http.Response response) decode,
  }) async {
    final uri = Uri.parse('$baseUrl$path').replace(queryParameters: query);
    final response = await _readWithRetry(
      () => _client.get(uri, headers: _headers()),
      retryTransient: retryTransient,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _apiException(response);
    }
    return decode(response);
  }

  /// Strict nullable object response: only JSON null means absence. Used for
  /// session validation, where malformed data must never imply invalid auth.
  Future<Map<String, dynamic>?> getNullableJson(
    String path, {
    bool retryTransient = true,
  }) async {
    final uri = Uri.parse('$baseUrl$path');
    final response = await _readWithRetry(
      () => _client.get(uri, headers: _headers()),
      retryTransient: retryTransient,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _apiException(response);
    }
    final decoded = jsonDecode(response.body);
    if (decoded == null) return null;
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('Expected a JSON object or null');
    }
    return decoded;
  }

  /// Issues a JSON GET to [path] expecting a top-level JSON **array**.
  /// Throws [ApiException] on any non-2xx response; returns an empty list when
  /// the body is empty or not an array.
  Future<List<dynamic>> getJsonList(
    String path, {
    Map<String, String>? query,
    bool retryTransient = true,
  }) async {
    final uri = Uri.parse('$baseUrl$path').replace(queryParameters: query);
    final response = await _readWithRetry(
      () => _client.get(uri, headers: _headers()),
      retryTransient: retryTransient,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _apiException(response);
    }
    if (response.body.isEmpty) return const [];
    final decoded = jsonDecode(response.body);
    return decoded is List ? decoded : const [];
  }

  /// Issues a JSON POST to [path] with an optional [body].
  /// Throws [ApiException] on any non-2xx response.
  Future<Map<String, dynamic>> postJson(String path, {Object? body}) async {
    final uri = Uri.parse('$baseUrl$path');
    final response = await _client.post(
      uri,
      headers: _headers(const {'Content-Type': 'application/json'}),
      body: body == null ? null : jsonEncode(body),
    );
    return _decode(response);
  }

  /// Issues a POST of raw [bytes] to [path] with [contentType] and optional
  /// [query]. Used for attachment uploads, whose contract is a bare body
  /// (not multipart). Throws [ApiException] on any non-2xx response.
  Future<Map<String, dynamic>> postBytes(
    String path, {
    required Uint8List bytes,
    required String contentType,
    Map<String, String>? query,
  }) async {
    final uri = Uri.parse('$baseUrl$path').replace(queryParameters: query);
    final response = await _client.post(
      uri,
      headers: _headers({'Content-Type': contentType}),
      body: bytes,
    );
    return _decode(response);
  }

  /// Issues a JSON PATCH to [path] with an optional [body].
  /// Tolerates an empty `204` body (returns an empty map).
  /// Throws [ApiException] on any non-2xx response.
  Future<Map<String, dynamic>> patchJson(String path, {Object? body}) async {
    final uri = Uri.parse('$baseUrl$path');
    final response = await _client.patch(
      uri,
      headers: _headers(const {'Content-Type': 'application/json'}),
      body: body == null ? null : jsonEncode(body),
    );
    return _decode(response);
  }

  /// Issues a JSON PUT to [path] with an optional [body].
  /// Tolerates an empty `204` body (returns an empty map).
  /// Throws [ApiException] on any non-2xx response.
  Future<Map<String, dynamic>> putJson(String path, {Object? body}) async {
    final uri = Uri.parse('$baseUrl$path');
    final response = await _client.put(
      uri,
      headers: _headers(const {'Content-Type': 'application/json'}),
      body: body == null ? null : jsonEncode(body),
    );
    return _decode(response);
  }

  /// Issues a DELETE to [path] with an optional JSON [body]. Completes on any
  /// 2xx response (ignoring the response body) and throws [ApiException] on any
  /// non-2xx response.
  Future<void> delete(String path, {Object? body}) async {
    final uri = Uri.parse('$baseUrl$path');
    final response = await _client.delete(
      uri,
      headers: body == null
          ? _headers()
          : _headers(const {'Content-Type': 'application/json'}),
      body: body == null ? null : jsonEncode(body),
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _apiException(response);
    }
  }

  /// Issues a DELETE to [path] and decodes the JSON response body.
  /// Tolerates an empty body (returns an empty map).
  /// Throws [ApiException] on any non-2xx response.
  Future<Map<String, dynamic>> deleteJson(String path) async {
    final uri = Uri.parse('$baseUrl$path');
    final response = await _client.delete(uri, headers: _headers());
    return _decode(response);
  }

  /// Issues a DELETE to [path] carrying an optional JSON [body].
  ///
  /// Unlike [delete], this sends a request body — some endpoints (e.g.
  /// `/api/account/devices`) require one to identify the resource being
  /// deleted. Tolerates an empty response body.
  /// Throws [ApiException] on any non-2xx response.
  Future<void> deleteJsonWithBody(String path, {Object? body}) async {
    final uri = Uri.parse('$baseUrl$path');
    final response = await _client.delete(
      uri,
      headers: _headers(const {'Content-Type': 'application/json'}),
      body: body == null ? null : jsonEncode(body),
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _apiException(response);
    }
  }

  /// Headers matching this client's auth (bearer token + optional 2FA proof),
  /// for hand-rolled requests that cannot use the JSON helpers — e.g. the
  /// Portal SSE event stream, which manages its own [http.Client] so it can
  /// hard-abort a held-open connection.
  Map<String, String> buildHeaders([Map<String, String>? extra]) =>
      _headers(extra);

  Map<String, String> _headers([Map<String, String>? extra]) {
    final token = tokenProvider?.call();
    final proof = twoFactorProofProvider?.call();
    final version = clientVersionProvider?.call();
    return {
      ..._defaultHeaders,
      clientSurfaceHeader: mobileClientSurface,
      if (version != null && _clientVersionPattern.hasMatch(version))
        clientSurfaceVersionHeader: version,
      if (token != null && token.isNotEmpty) 'Authorization': 'Bearer $token',
      if (proof != null && proof.isNotEmpty) 'x-two-factor-verified': proof,
      ...?extra,
    };
  }

  Future<http.Response> _readWithRetry(
    Future<http.Response> Function() request, {
    required bool retryTransient,
  }) async {
    for (var retryIndex = 0; ; retryIndex++) {
      try {
        final response = await request();
        if (!retryTransient ||
            retryIndex >= _maxReadRetries ||
            !_isTransientStatus(response.statusCode)) {
          return response;
        }
      } catch (error) {
        if (!retryTransient ||
            retryIndex >= _maxReadRetries ||
            !_isTransientTransportError(error)) {
          rethrow;
        }
      }
      await Future<void>.delayed(_readRetryDelay(retryIndex));
    }
  }

  Map<String, dynamic> _decode(http.Response response) {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _apiException(response);
    }
    if (response.body.isEmpty) return const <String, dynamic>{};
    final decoded = jsonDecode(response.body);
    return decoded is Map<String, dynamic>
        ? decoded
        : const <String, dynamic>{};
  }

  ApiException _apiException(http.Response response) => ApiException(
    statusCode: response.statusCode,
    body: response.body,
    headers: Map.unmodifiable(response.headers),
  );
}
