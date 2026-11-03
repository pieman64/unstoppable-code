import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pipeline_dispatch.dart';

void main() {
  group('RemotePipelineDescriptor', () {
    test('parses a state row and defaults scopes to directory', () {
      final descriptor = RemotePipelineDescriptor.fromJson({
        'localId': 'wt-1:deploy',
        'pipelineId': 'deploy',
        'name': 'Deploy',
        'description': 'Ships it',
        'origin': 'bundled',
        'triggerTypes': ['dispatch'],
      })!;
      expect(descriptor.pipelineId, 'deploy');
      expect(descriptor.name, 'Deploy');
      expect(descriptor.description, 'Ships it');
      expect(descriptor.origin, RemotePipelineOrigin.bundled);
      expect(descriptor.scopes, ['directory']);
      expect(descriptor.isDispatchable, isTrue);
    });

    test('an absent origin reads as project', () {
      final descriptor = RemotePipelineDescriptor.fromJson({
        'pipelineId': 'ci',
        'name': 'CI',
        'triggerTypes': ['dispatch'],
      })!;
      expect(descriptor.origin, RemotePipelineOrigin.project);
    });

    test(
      'only dispatch-trigger, worktree-capable, non-shared rows dispatch',
      () {
        RemotePipelineDescriptor row(Map<String, dynamic> extra) =>
            RemotePipelineDescriptor.fromJson({
              'pipelineId': 'p',
              'name': 'P',
              'triggerTypes': ['dispatch'],
              ...extra,
            })!;
        expect(
          row({
            'triggerTypes': ['plan_ready'],
          }).isDispatchable,
          isFalse,
        );
        expect(
          row({
            'scopes': ['global'],
          }).isDispatchable,
          isFalse,
        );
        expect(
          row({
            'scopes': ['worktree'],
          }).isDispatchable,
          isTrue,
        );
        expect(row({'origin': 'shared'}).isDispatchable, isFalse);
        expect(
          row({'pipelineId': 'shared:canopy-cloud:abc'}).isDispatchable,
          isFalse,
        );
      },
    );

    test('rejects rows without an id', () {
      expect(RemotePipelineDescriptor.fromJson({'name': 'x'}), isNull);
      expect(RemotePipelineDescriptor.fromJson('nope'), isNull);
    });
  });

  group('RemotePipelineDispatchForm.fromGetResult', () {
    test('parses inputs in declaration order with stringified defaults', () {
      final form = RemotePipelineDispatchForm.fromGetResult({
        'definition': {'name': 'Deploy'},
        'dispatchInputs': {
          'environment': {
            'type': 'choice',
            'required': true,
            'options': ['staging', 'production'],
            'description': 'Where to',
          },
          'count': {'type': 'number', 'min': 1, 'max': 5, 'default': 2},
          'dry_run': {'type': 'boolean', 'default': false},
          'token': {'hint-hide-ui-option': true, 'default': 'x'},
        },
      });
      expect(form.inputs.map((input) => input.name), [
        'environment',
        'count',
        'dry_run',
        'token',
      ]);
      final environment = form.inputs[0];
      expect(environment.type, RemotePipelineInputType.choice);
      expect(environment.required, isTrue);
      expect(environment.options, ['staging', 'production']);
      expect(environment.description, 'Where to');
      expect(form.inputs[1].min, 1);
      expect(form.inputs[1].max, 5);
      expect(form.inputs[1].defaultValue, '2');
      expect(form.inputs[2].type, RemotePipelineInputType.boolean);
      expect(form.inputs[2].defaultValue, 'false');
      expect(form.inputs[3].type, RemotePipelineInputType.string);
      expect(form.inputs[3].hideInUi, isTrue);
      expect(form.canDispatch, isTrue);
    });

    test('a pipeline with no inputs can dispatch', () {
      final form = RemotePipelineDispatchForm.fromGetResult({
        'definition': {'name': 'Lint'},
      });
      expect(form.inputs, isEmpty);
      expect(form.canDispatch, isTrue);
    });

    test('omitted or unsupported inputs cannot dispatch', () {
      expect(
        RemotePipelineDispatchForm.fromGetResult({
          'dispatchInputsOmitted': true,
        }).canDispatch,
        isFalse,
      );
      final unsupported = RemotePipelineDispatchForm.fromGetResult({
        'dispatchUnsupportedReason': 'json_input',
      });
      expect(unsupported.unsupportedReason, 'json_input');
      expect(unsupported.canDispatch, isFalse);
    });
  });
}
