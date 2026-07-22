import fc from "fast-check";

const configuredSeed = Number.parseInt(process.env.FC_SEED ?? "20250213", 10);
const seed = Number.isFinite(configuredSeed) ? configuredSeed : 20250213;

// Keep property runs reproducible while allowing a reported seed/path to be replayed by fast-check.
fc.configureGlobal({ seed, endOnFailure: true });
