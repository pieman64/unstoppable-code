import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/model_routing_availability.dart';
import 'package:mobile/ui/core/chat/view_models/model_picker_catalog.dart';

ModelOption _row(
  String id, {
  String provider = 'claude',
  String? source,
  String? harness,
  String? vendor,
  double? sortOrder,
  bool legacy = false,
  String kind = 'model',
  bool available = true,
}) => ModelOption(
  id: id,
  label: id,
  provider: provider,
  source: source,
  harness: harness,
  vendor: vendor,
  sortOrder: sortOrder,
  showMoreOnly: legacy,
  kind: kind,
  available: available,
);

void main() {
  test('vendor labels follow desktop, with Anthropic shown as Claude', () {
    expect(modelVendorLabel('anthropic'), 'Claude');
    expect(modelVendorLabel('openai'), 'OpenAI');
    expect(modelVendorLabel('moonshotai'), 'Moonshot AI');
    expect(modelVendorLabel('zai'), 'Z.ai');
    expect(modelVendorLabel('acme'), 'Acme');
    expect(modelVendorLabel(''), 'Other');
  });

  test('context windows use the compact desktop format', () {
    expect(formatModelContextWindow(1000000), '1M');
    expect(formatModelContextWindow(1500000), '1.5M');
    expect(formatModelContextWindow(200000), '200K');
    expect(formatModelContextWindow(512), '512');
    expect(formatModelContextWindow(0), isNull);
    expect(formatModelContextWindow(null), isNull);
  });

  test('tabs put connected harnesses first and reported disconnects last', () {
    final rows = [
      _row('cursor', provider: 'cursor', source: 'cursor'),
      _row('opus', vendor: 'anthropic'),
      _row('codex', provider: 'codex'),
      _row('open', provider: 'opencode', source: 'opencode'),
    ];
    expect(modelPickerTabs(rows, const ProviderAvailability(claude: true)), [
      ModelPickerTab.all,
      ModelPickerTab.claude,
      ModelPickerTab.codex,
      ModelPickerTab.other,
      ModelPickerTab.cursor,
    ]);
    // A reported disconnect earns a tab without rows; an unknown one does not.
    expect(
      modelPickerTabs([
        _row('opus'),
      ], const ProviderAvailability(ollama: false)),
      [ModelPickerTab.all, ModelPickerTab.claude, ModelPickerTab.ollama],
    );
  });

  test('a native source keeps its tab when another harness runs the row, '
      'like desktop', () {
    final ollama = _row(
      'qwen',
      provider: 'ollama',
      source: 'ollama',
      harness: 'codex',
    );
    final olderHost = _row('llama', provider: 'ollama', harness: 'codex');
    final claude = _row('opus', source: 'claude', harness: 'codex');
    final gateway = _row(
      'ds',
      provider: 'codex',
      source: 'ai-gateway',
      harness: 'codex',
    );
    final rows = [ollama, olderHost, claude, gateway];

    expect(modelRowTab(ollama), ModelPickerTab.ollama);
    expect(modelRowTab(olderHost), ModelPickerTab.ollama);
    expect(modelRowTab(claude), ModelPickerTab.claude);
    expect(modelRowTab(gateway), ModelPickerTab.codex);
    expect(modelPickerTabs(rows, const ProviderAvailability(ollama: true)), [
      ModelPickerTab.all,
      ModelPickerTab.claude,
      ModelPickerTab.codex,
      ModelPickerTab.ollama,
    ]);
    expect(
      modelPickerSections(
        rows,
        ModelPickerTab.ollama,
      ).expand((section) => section.rows).map((row) => row.id),
      ['llama', 'qwen'],
    );
    expect(
      modelPickerSections(
        rows,
        ModelPickerTab.codex,
      ).expand((section) => section.rows).map((row) => row.id),
      ['ds'],
    );
    expect(modelPickerSearch([ollama], 'qwen').single.title, 'Ollama');
    // The harness that runs the row still decides the chat lock.
    expect(
      modelRowDisabledReason(
        ollama,
        availability: null,
        lockedHarness: 'codex',
      ),
      isNull,
    );
    expect(
      modelRowDisabledReason(
        ollama,
        availability: null,
        lockedHarness: 'claude',
      ),
      'This chat is running on Claude. Start a new chat to use Codex models.',
    );
  });

  test('All groups by vendor in sortOrder, with Agents first and Legacy '
      'at the end of each section', () {
    final sections = modelPickerSections([
      _row('gpt', provider: 'codex', vendor: 'openai', sortOrder: 20),
      _row('sonnet', vendor: 'anthropic', sortOrder: 15),
      _row('opus', vendor: 'anthropic', sortOrder: 10),
      _row('old', vendor: 'anthropic', sortOrder: 5, legacy: true),
      _row('plain'),
      _row('agent', kind: 'agent', available: false),
    ], ModelPickerTab.all);
    expect(sections.map((s) => s.title), [
      'Agents',
      'Claude',
      'OpenAI',
      'Other models',
    ]);
    expect(sections[1].rows.map((r) => r.id), ['opus', 'sonnet']);
    expect(sections[1].legacy.map((r) => r.id), ['old']);
  });

  test('a harness tab lists native vendors, then Other supported models', () {
    final sections = modelPickerSections([
      _row('gpt', provider: 'codex', source: 'codex', vendor: 'openai'),
      _row(
        'deepseek',
        provider: 'codex',
        source: 'ai-gateway',
        harness: 'codex',
        vendor: 'deepseek',
      ),
      _row('opus', vendor: 'anthropic'),
    ], ModelPickerTab.codex);
    expect(sections.map((s) => s.title), ['OpenAI', 'Other supported models']);
    expect(sections.last.rows.single.id, 'deepseek');
  });

  test('a harness tab lists only its own Agents; All models keeps every '
      'Agent', () {
    final rows = [
      _row('claude-agent', kind: 'agent'),
      _row('codex-agent', provider: 'codex', source: 'codex', kind: 'agent'),
      _row('gpt', provider: 'codex', source: 'codex', vendor: 'openai'),
      _row('opus', vendor: 'anthropic'),
    ];
    List<String> agentsOn(ModelPickerTab tab) => [
      for (final section in modelPickerSections(rows, tab))
        if (section.key == 'agents') ...section.rows.map((row) => row.id),
    ];
    expect(agentsOn(ModelPickerTab.all), ['claude-agent', 'codex-agent']);
    expect(agentsOn(ModelPickerTab.claude), ['claude-agent']);
    expect(agentsOn(ModelPickerTab.codex), ['codex-agent']);
    expect(
      modelPickerSections(rows, ModelPickerTab.cursor).map((s) => s.key),
      isEmpty,
    );
  });

  test('an empty catalog keeps tabs for reported connection states', () {
    expect(
      modelPickerTabs(const [], const ProviderAvailability(cursor: false)),
      [ModelPickerTab.all, ModelPickerTab.cursor],
    );
  });

  test('search scores contiguous matches first and groups by harness', () {
    final rows = [
      _row('gpt-5-codex', provider: 'codex'),
      _row('claude-opus', vendor: 'anthropic'),
      _row('claude-sonnet', vendor: 'anthropic'),
    ];
    expect(fuzzyModelScore(rows[1], 'opus'), lessThan(100));
    expect(fuzzyModelScore(rows[1], 'cldop'), greaterThanOrEqualTo(100));
    expect(fuzzyModelScore(rows[0], 'zzz'), double.infinity);
    final results = modelPickerSearch(rows, 'anthropic');
    expect(results.single.title, 'Claude');
    expect(results.single.rows.map((r) => r.id), [
      'claude-opus',
      'claude-sonnet',
    ]);
    expect(modelPickerSearch(rows, 'zzz'), isEmpty);
  });

  test('disabled reasons use the desktop copy', () {
    const signedOut = ProviderAvailability(codex: false);
    expect(
      modelRowDisabledReason(
        _row('cursor', provider: 'cursor'),
        availability: null,
        lockedHarness: null,
      ),
      'Connect Cursor in the desktop app to use it here.',
    );
    expect(
      modelRowDisabledReason(
        _row('gpt', provider: 'codex'),
        availability: null,
        lockedHarness: 'claude',
      ),
      'This chat is running on Claude. Start a new chat to use Codex models.',
    );
    expect(
      modelRowDisabledReason(
        _row('gpt', provider: 'codex'),
        availability: signedOut,
        lockedHarness: null,
      ),
      'Codex is not signed in on the desktop app.',
    );
    // AI Gateway rows run on credits, not the native sign-in.
    expect(
      modelRowDisabledReason(
        _row('ds', provider: 'codex', source: 'ai-gateway', harness: 'codex'),
        availability: signedOut,
        lockedHarness: null,
      ),
      isNull,
    );
    expect(
      modelRowDisabledReason(
        _row('agent', kind: 'agent', available: false),
        availability: null,
        lockedHarness: null,
      ),
      contains('base model is not registered'),
    );
  });

  // CAN-2872: a guest's locked rows name the web and desktop remedy.
  test('a sign-in lock explains itself with the shared unlock hint', () {
    ModelOption locked(String reason) => ModelOption(
      id: 'opus',
      label: 'Opus',
      provider: 'claude',
      source: 'ai-gateway',
      harness: 'claude',
      kind: 'model',
      available: false,
      unavailableReason: reason,
    );

    expect(
      modelRowDisabledReason(
        locked('needs_sign_in'),
        availability: null,
        lockedHarness: null,
      ),
      'Unlock with sign-in',
    );
    expect(
      modelRowDisabledReason(
        locked('needs_sign_in_then_purchase'),
        availability: null,
        lockedHarness: null,
      ),
      'Unlock with sign-in and AI Credit purchase',
    );
    expect(modelLibrarySignInLock('needs_sign_in'), 'needs_sign_in');
    expect(
      modelLibrarySignInLock('needs_sign_in_then_purchase'),
      'needs_sign_in_then_purchase',
    );
    for (final access in ['unlocked', 'needs_purchase', null, 'other']) {
      expect(modelLibrarySignInLock(access), isNull, reason: '$access');
    }
    expect(modelLibraryUnlockLabel('needs_sign_in'), 'Sign in');
    expect(modelLibraryUnlockLabel('needs_sign_in_then_purchase'), 'Sign in');
    expect(modelLibraryUnlockLabel('base_model_unavailable'), isNull);
    expect(modelLibraryUnlockLabel(null), isNull);
  });

  test('an unconnected Copilot row stays in Other models but cannot be '
      'picked or counted by Auto', () {
    final copilot = _row('gpt-cp', provider: 'copilot', source: 'copilot');
    final rows = [_row('opus'), copilot];
    String? reason(ProviderAvailability? reported) => modelRowDisabledReason(
      copilot,
      availability: reported,
      lockedHarness: null,
    );
    String? auto(ProviderAvailability? reported) => modelAutoRow(
      selected: false,
      availability: ModelRoutingAvailability.available,
      rows: rows,
      providerAvailability: reported,
      lockedHarness: null,
    )?.reason;

    expect(modelRowTab(copilot), ModelPickerTab.other);
    expect(modelPickerSections(rows, ModelPickerTab.other).single.rows, [
      copilot,
    ]);
    // Unreported fails closed: no availability (Cloud) or an omitted key.
    for (final reported in [
      null,
      ProviderAvailability.fromJson(const {}),
      ProviderAvailability.fromJson(const {'copilot': false}),
    ]) {
      expect(
        reason(reported),
        'Connect Copilot in the desktop app to use it here.',
      );
      expect(auto(reported), 'Needs two or more models');
    }
    final connected = ProviderAvailability.fromJson(const {'copilot': true});
    expect(reason(connected), isNull);
    expect(auto(connected), isNull);
  });

  test('Auto counts pickable models and excludes Agents', () {
    ModelAutoRow? row(List<ModelOption> rows, {String? locked}) => modelAutoRow(
      selected: false,
      availability: ModelRoutingAvailability.available,
      rows: rows,
      providerAvailability: null,
      lockedHarness: locked,
    );
    final two = [_row('a'), _row('b')];
    expect(row(two)?.reason, isNull);
    expect(
      row([_row('a'), _row('agent', kind: 'agent')])?.reason,
      'Needs two or more models',
    );
    expect(
      row([_row('a'), _row('c', provider: 'codex')], locked: 'claude')?.reason,
      'Needs two or more models',
    );
  });
}
