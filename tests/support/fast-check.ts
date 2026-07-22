import * as fc from "fast-check";

export const deterministicFastCheckParameters = (seed: number, numRuns = 100) => ({
  seed,
  numRuns,
  endOnFailure: true,
});

export const runSeeded = <T>(property: fc.IProperty<T>, seed: number, numRuns = 100): void => {
  fc.assert(property, deterministicFastCheckParameters(seed, numRuns));
};

export { fc };
