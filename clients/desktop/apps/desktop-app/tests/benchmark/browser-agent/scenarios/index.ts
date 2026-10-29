import { generalScenarios } from './general';
import { guardrailScenarios } from './guardrails';
import { theInternetScenarios } from './the-internet';

export const allScenarios = [
  ...theInternetScenarios,
  ...generalScenarios,
  ...guardrailScenarios,
];
