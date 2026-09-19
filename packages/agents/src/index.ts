/**
 * @aw/agents — the decision layer.
 *
 * Depends on @aw/types and nothing else in this repository. In particular it
 * has no path, direct or transitive, to the module that holds private keys:
 * the agent proposes, the engine disposes, and only the settlement layer signs.
 * A test in tests/agents/boundary.test.ts enforces both that rule and the rule
 * that no world's vocabulary may appear in this source.
 */

export * from './rng.ts';
export * from './traits.ts';
export * from './memory.ts';
export * from './lens.ts';
export * from './observe.ts';
export * from './engines/index.ts';
export * from './providers/index.ts';
export * from './agent.ts';
export * from './factory.ts';
