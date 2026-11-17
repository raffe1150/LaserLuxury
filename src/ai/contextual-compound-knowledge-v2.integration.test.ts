// Same P0 2026-11-17 matrix under the plain v2 verifier protocol (production uses
// source-exhaustive-v2). Expectations that differ by protocol are in the shared file.
process.env.CONTEXTUAL_COMPOUND_PROTOCOL = 'v2';
await import('./contextual-compound-knowledge.integration.test.ts');
