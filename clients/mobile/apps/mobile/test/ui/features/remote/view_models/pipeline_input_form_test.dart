import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pipeline_dispatch.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_input_form.dart';

const _choice = RemotePipelineInputDefinition(
  name: 'environment',
  required: true,
  type: RemotePipelineInputType.choice,
  options: ['staging', 'production'],
);
const _number = RemotePipelineInputDefinition(
  name: 'count',
  type: RemotePipelineInputType.number,
  min: 1,
  max: 5,
);

void main() {
  test('hides hint-hide inputs unless required with no default', () {
    const hiddenOptional = RemotePipelineInputDefinition(
      name: 'a',
      hideInUi: true,
    );
    const hiddenWithDefault = RemotePipelineInputDefinition(
      name: 'b',
      hideInUi: true,
      required: true,
      defaultValue: 'x',
    );
    const hiddenRequired = RemotePipelineInputDefinition(
      name: 'c',
      hideInUi: true,
      required: true,
    );
    expect(
      visiblePipelineInputs([
        hiddenOptional,
        hiddenWithDefault,
        hiddenRequired,
        _choice,
      ]).map((input) => input.name),
      ['c', 'environment'],
    );
  });

  test('seeds defaults and blanks', () {
    expect(
      initialPipelineInputValues([
        _choice,
        const RemotePipelineInputDefinition(name: 'n', defaultValue: '2'),
      ]),
      {'environment': '', 'n': '2'},
    );
  });

  test('validates with the desktop and web messages', () {
    expect(validatePipelineInputs([_choice, _number], {}), {
      'environment': 'This field is required',
    });
    expect(validatePipelineInputs([_number], {'count': 'abc'}), {
      'count': 'Must be a valid number',
    });
    expect(validatePipelineInputs([_number], {'count': '0'}), {
      'count': 'Must be at least 1',
    });
    expect(validatePipelineInputs([_number], {'count': '9'}), {
      'count': 'Must be at most 5',
    });
    expect(validatePipelineInputs([_choice], {'environment': 'dev'}), {
      'environment': 'Must be one of: staging, production',
    });
    expect(
      validatePipelineInputs(
        [_choice, _number],
        {'environment': ' staging ', 'count': '3'},
      ),
      isEmpty,
    );
  });

  test('payload keeps trimmed non-empty values only', () {
    expect(
      buildPipelineInputPayload(
        [_choice, _number],
        {'environment': ' staging ', 'count': ''},
      ),
      {'environment': 'staging'},
    );
  });
}
