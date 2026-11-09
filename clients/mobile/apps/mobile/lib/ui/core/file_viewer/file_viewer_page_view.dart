import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:mobile/ui/core/external_links.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_page.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_view_model.dart';

/// Renders an HTML file with its stylesheets and images, in a webview the
/// page cannot leave.
///
/// The page and every file it links to are answered from the computer root
/// through [FileViewerViewModel.readPageAsset]. Scripts do not run: a script
/// on this origin could read other files under the root, and no browser
/// setting closes every channel it could send them through. The webview also
/// refuses every request off the page's origin, the document carries
/// [fileViewerPagePolicy], dotfiles are never served, and only a link the
/// person taps opens in the browser. The page gets its own origin and cannot
/// open windows or ask for device permissions.
class FileViewerPageView extends StatefulWidget {
  const FileViewerPageView({super.key, required this.file});

  final FileViewerViewModel file;

  @override
  State<FileViewerPageView> createState() => _FileViewerPageViewState();
}

class _FileViewerPageViewState extends State<FileViewerPageView> {
  static final _intercepts = defaultTargetPlatform == TargetPlatform.android;

  late final FileViewerPageOrigin _origin = _intercepts
      ? FileViewerPageOrigin.interceptedHttps(fileViewerPageId())
      : FileViewerPageOrigin.customScheme(fileViewerPageId());

  late final _settings = InAppWebViewSettings(
    resourceCustomSchemes: _intercepts
        ? const []
        : [FileViewerPageOrigin.customSchemeName],
    useShouldInterceptRequest: _intercepts,
    useShouldOverrideUrlLoading: true,
    incognito: true,
    cacheEnabled: false,
    javaScriptEnabled: false,
    javaScriptBridgeEnabled: false,
    // Android answers every request in [_intercept]; WebKit cannot intercept
    // HTTPS, so content rules block the network there.
    contentBlockers: _intercepts
        ? const []
        : [
            for (final pattern in const ['^https?:', '^wss?:', '^ftp:'])
              ContentBlocker(
                trigger: ContentBlockerTrigger(urlFilter: pattern),
                action: ContentBlockerAction(
                  type: ContentBlockerActionType.BLOCK,
                ),
              ),
          ],
    javaScriptCanOpenWindowsAutomatically: false,
    supportMultipleWindows: false,
    allowFileAccess: false,
    allowContentAccess: false,
    allowFileAccessFromFileURLs: false,
    allowUniversalAccessFromFileURLs: false,
    geolocationEnabled: false,
    mediaPlaybackRequiresUserGesture: true,
    thirdPartyCookiesEnabled: false,
    allowsLinkPreview: false,
  );

  Future<({Uint8List? bytes, String type})> _asset(Uri url) async {
    final path = _origin.path(url);
    if (path == null || !fileViewerPageMayRead(path)) {
      return (bytes: null, type: 'text/plain');
    }
    final type = fileViewerMediaType(path);
    final bytes = await widget.file.readPageAsset(path);
    if (bytes == null || type != 'text/html') return (bytes: bytes, type: type);
    // Each HTML document, including frames, carries the policy.
    final html = utf8.decode(bytes, allowMalformed: true);
    return (
      bytes: utf8.encode(fileViewerPageDocument(html, _origin)),
      type: type,
    );
  }

  /// WebKit waits on a request the handler never answers, so a missing file
  /// gets an empty body.
  Future<CustomSchemeResponse?> _customScheme(
    WebResourceRequest request,
  ) async {
    final asset = await _asset(request.url);
    return CustomSchemeResponse(
      data: asset.bytes ?? Uint8List(0),
      contentType: asset.type,
    );
  }

  /// Every request is answered here: off the page's origin it is refused,
  /// so nothing reaches the network.
  Future<WebResourceResponse?> _intercept(WebResourceRequest request) async {
    if (!_origin.owns(request.url)) {
      return WebResourceResponse(
        data: Uint8List(0),
        contentType: 'text/plain',
        statusCode: 403,
        reasonPhrase: 'Forbidden',
      );
    }
    final asset = await _asset(request.url);
    final found = asset.bytes != null;
    return WebResourceResponse(
      data: asset.bytes ?? Uint8List(0),
      contentType: asset.type,
      statusCode: found ? 200 : 404,
      reasonPhrase: found ? 'OK' : 'Not Found',
    );
  }

  NavigationActionPolicy _navigate(
    Uri? url, {
    required bool mainFrame,
    required bool userInitiated,
  }) {
    if (url == null) return NavigationActionPolicy.CANCEL;
    switch (fileViewerNavigation(
      _origin,
      url,
      mainFrame: mainFrame,
      userInitiated: userInitiated,
    )) {
      case FileViewerNavigation.allow:
        return NavigationActionPolicy.ALLOW;
      case FileViewerNavigation.openExternally:
        unawaited(openExternalUrl(url.toString()));
        return NavigationActionPolicy.CANCEL;
      case FileViewerNavigation.block:
        return NavigationActionPolicy.CANCEL;
    }
  }

  /// Android reports a gesture; iOS reports an activated link, which only a
  /// person can cause while scripts are off.
  static bool _tapped(NavigationAction action) =>
      action.hasGesture == true ||
      action.navigationType == NavigationType.LINK_ACTIVATED;

  @override
  Widget build(BuildContext context) {
    final path = widget.file.path;
    if (path == null) return const SizedBox.shrink();
    return InAppWebView(
      key: const ValueKey('file-viewer-page'),
      initialUrlRequest: URLRequest(url: WebUri.uri(_origin.url(path))),
      initialSettings: _settings,
      onLoadResourceWithCustomScheme: _intercepts
          ? null
          : (_, request) => _customScheme(request),
      shouldInterceptRequest: _intercepts
          ? (_, request) => _intercept(request)
          : null,
      shouldOverrideUrlLoading: (_, action) async => _navigate(
        action.request.url,
        mainFrame: action.isForMainFrame,
        userInitiated: _tapped(action),
      ),
      onCreateWindow: (_, action) async {
        _navigate(
          action.request.url,
          mainFrame: true,
          userInitiated: _tapped(action),
        );
        return false;
      },
      onPermissionRequest: (_, request) async => PermissionResponse(
        resources: request.resources,
        action: PermissionResponseAction.DENY,
      ),
    );
  }
}
