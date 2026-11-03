import 'package:mobile/config/app_config.dart';
import 'package:url_launcher/url_launcher.dart';

/// Opens [url] in the system browser (or the platform's registered handler).
///
/// Fire-and-forget: a failed launch (malformed URL, or no handler installed)
/// is a silent no-op rather than an error the caller has to render. This is
/// the single `launchUrl` site in the app — transcript markdown links and the
/// org billing CTA both route through here.
Future<void> openExternalUrl(String url) async {
  final uri = Uri.tryParse(url.trim());
  if (uri == null) return;
  try {
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (_) {
    // No handler installed, or the platform refused. Nothing useful to say.
  }
}

/// The web billing settings page for [orgId].
///
/// Mirrors `organizationBillingPath` in `packages/protocol/src/billing/index.ts`,
/// which is the source of truth for this shape. Dart cannot import it, so the
/// path is duplicated here and pinned by a unit test.
///
/// [AppConfig.apiBaseUrl] is the same origin as the web app in every
/// environment, so no additional configuration is needed.
String orgBillingUrl(String orgId) {
  final base = AppConfig.apiBaseUrl;
  return '$base/organization/${Uri.encodeComponent(orgId)}/settings?tab=billing';
}

/// The web desktop app download page on the current environment's origin.
///
/// Mirrors `DOWNLOAD_URL` in `apps/web/src/lib/marketing-links.ts`; pinned by
/// a unit test. On production the app origin redirects marketing pages such
/// as this one to the marketing origin, which is fine for a shared link.
String desktopDownloadUrl() => '${AppConfig.apiBaseUrl}/download';
