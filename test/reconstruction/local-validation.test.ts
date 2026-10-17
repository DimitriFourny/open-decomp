import test from 'node:test';
import { localValidationCounterexamples } from './local-validation-cases.js';

test(
  'independent bounded translation checks publish concrete counterexamples and honest scope',
  localValidationCounterexamples,
);
