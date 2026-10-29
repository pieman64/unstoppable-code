import {
  CopilotPolicyError,
  describeCopilotServiceRefusal,
} from '../copilot/service-errors';

describe('describeCopilotServiceRefusal', () => {
  it('recognizes the Copilot service policy refusal body', () => {
    expect(
      describeCopilotServiceRefusal(
        new Error(
          'Request models.list failed with message: GenericFailure, {"kind":"http","status":403,"statusText":"Forbidden","body":"unauthorized: not authorized to use this Copilot feature\\n"}',
        ),
      ),
    ).toBeInstanceOf(CopilotPolicyError);
  });

  it("recognizes the CLI's policy wording", () => {
    expect(
      describeCopilotServiceRefusal('Access denied by policy settings'),
    ).toBeInstanceOf(CopilotPolicyError);
  });

  it('leaves a bare 403, a missing seat and unrelated policy text alone', () => {
    for (const message of [
      '403',
      'Request models.list failed with message: GenericFailure, {"kind":"http","status":403,"body":"unauthorized: not licensed to use Copilot"}',
      'This action requires an organization policy to allow it',
      undefined,
    ])
      expect(describeCopilotServiceRefusal(message)).toBeUndefined();
  });
});
