/// Mobile has one route in place of the desktop Orchestrator window. Preparing
/// that route must work while another page is visible; only the UI reports focus.
final class DesktopOrchestratorWindow {
  bool visible = false;
  Map<String, dynamic> get state => {'open': visible, 'focused': visible};

  Map<String, dynamic>? handle(String method, Object? params) {
    if (method != 'appAdvisor.window' || params is! Map) return null;
    if (!const [
      'open',
      'ensure',
      'close',
      'focus_main',
    ].contains(params['action'])) {
      return null;
    }
    // Desktop requests can prepare a bridge and deliver questions in the
    // background. They cannot claim that a mobile route was shown or hidden.
    return state;
  }
}
