import 'dart:math';

import 'package:mime/mime.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_path.dart';

/// Where a rendered page and the files it links to live inside the webview.
/// The page loads from a private address the viewer answers itself, so its
/// relative links resolve to files under the same computer root.
///
/// Each viewer gets its own host, so pages never share an origin.
final class FileViewerPageOrigin {
  const FileViewerPageOrigin._(this.scheme, this.host);

  /// WebKit serves a registered custom scheme as a normal hierarchical URL.
  factory FileViewerPageOrigin.customScheme(String id) =>
      FileViewerPageOrigin._(customSchemeName, '$id.local');

  /// Android WebView cannot resolve relative links against an unregistered
  /// scheme, so it intercepts an HTTPS host that can never resolve instead.
  factory FileViewerPageOrigin.interceptedHttps(String id) =>
      FileViewerPageOrigin._('https', '$id.worktree-file.invalid');

  static const customSchemeName = 'worktree-file';

  final String scheme;
  final String host;

  /// The origin as CSP and the web platform write it.
  String get origin => '$scheme://$host';

  Uri url(String path) =>
      Uri(scheme: scheme, host: host, pathSegments: path.split('/'));

  bool owns(Uri url) =>
      url.scheme == scheme && url.host == host && !url.hasPort;

  /// The root-relative file [url] names, or null when it is not on this
  /// origin or its path is unsafe. Queries and fragments are ignored.
  String? path(Uri url) =>
      owns(url) ? normalizeFileViewerPath(url.pathSegments.join('/')) : null;
}

/// A random, DNS-safe label for one viewer's origin.
String fileViewerPageId([Random? random]) {
  final source = random ?? Random.secure();
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return List.generate(
    16,
    (_) => alphabet[source.nextInt(alphabet.length)],
  ).join();
}

/// Whether the page may read [path]. Dotfiles such as `.env` and anything
/// under `.git` hold credentials and configuration, never page assets.
/// Folders such as `.playwright` still serve the files inside them.
///
/// This checks names only: the computer follows symlinks under the root, so
/// a link with another name still reads its target. With scripts and the
/// network off, such a file can only appear inside the page itself.
bool fileViewerPageMayRead(String path) {
  final segments = path.split('/');
  return !segments.last.startsWith('.') && !segments.contains('.git');
}

/// The policy every served HTML document starts with: no scripts, and
/// nothing loads from outside the page's own origin. It goes first in the
/// document; a page can add stricter policies but never loosen this one.
String fileViewerPagePolicy(FileViewerPageOrigin origin) => [
  "default-src 'self' ${origin.origin} 'unsafe-inline' data: blob:",
  "script-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

final _doctype = RegExp(r'^\s*(?:﻿)?\s*<!doctype[^>]*>', caseSensitive: false);

/// [html] with [fileViewerPagePolicy] as its first element. A leading
/// doctype stays first, so the page keeps its rendering mode.
String fileViewerPageDocument(String html, FileViewerPageOrigin origin) {
  final policy = fileViewerPagePolicy(origin);
  final meta = '<meta http-equiv="Content-Security-Policy" content="$policy">';
  final doctype = _doctype.firstMatch(html);
  return doctype == null
      ? '$meta$html'
      : '${html.substring(0, doctype.end)}$meta${html.substring(doctype.end)}';
}

enum FileViewerNavigation { allow, openExternally, block }

/// What the page may do when it navigates to [url]. The page stays on its
/// own origin. A web link the person taps opens in the browser; nothing else,
/// such as a meta refresh, may send the browser anywhere.
FileViewerNavigation fileViewerNavigation(
  FileViewerPageOrigin origin,
  Uri url, {
  required bool mainFrame,
  required bool userInitiated,
}) {
  if (origin.owns(url)) return FileViewerNavigation.allow;
  if (!mainFrame) {
    return url.scheme == 'about' && url.path == 'blank'
        ? FileViewerNavigation.allow
        : FileViewerNavigation.block;
  }
  final web = url.scheme == 'https' || url.scheme == 'http';
  return userInitiated && (web || url.scheme == 'mailto')
      ? FileViewerNavigation.openExternally
      : FileViewerNavigation.block;
}

/// The content type the page receives for a file.
String fileViewerMediaType(String path) {
  final name = path.split('/').last.toLowerCase();
  if (name.endsWith('.mjs')) return 'text/javascript';
  return lookupMimeType(name) ?? 'application/octet-stream';
}
