// The rule language: declarative predicates and effects.
//
// Rules are DATA, not code. This is what makes replay deterministic, lets an LLM
// generate a world safely, and lets the engine validate a rule before running it.
// There is deliberately no escape hatch into arbitrary functions.

/** A path into the evaluation scope, e.g. "$actor.resources.SOL", "$params.price". */
export type Path = string;

/** A literal, a path reference, or a nested computation. */
export type Expr =
  | number
  | string
  | boolean
  | null
  | { ref: Path }
  | { add: Expr[] }
  | { sub: [Expr, Expr] }
  | { mul: Expr[] }
  | { div: [Expr, Expr] }
  | { min: Expr[] }
  | { max: Expr[] }
  | { count: { of: string; where?: Predicate } };

export type Predicate =
  | { eq: [Expr, Expr] }
  | { ne: [Expr, Expr] }
  | { gt: [Expr, Expr] }
  | { gte: [Expr, Expr] }
  | { lt: [Expr, Expr] }
  | { lte: [Expr, Expr] }
  | { and: Predicate[] }
  | { or: Predicate[] }
  | { not: Predicate }
  | { has: Path };

export type Effect =
  | { op: 'set'; path: Path; value: Expr }
  | { op: 'increment'; path: Path; by: Expr }
  | { op: 'decrement'; path: Path; by: Expr }
  | { op: 'spawn'; type: string; attributes?: Record<string, Expr>; bind?: string }
  | { op: 'destroy'; path: Path }
  | { op: 'relate'; from: Path; to: Path; kind: string }
  | { op: 'unrelate'; from: Path; to: Path; kind: string }
  /** Marks this transfer as requiring on-chain settlement. The rule knows
   *  nothing about Solana; the settlement layer decides how it becomes a tx. */
  | { op: 'settle'; asset: string; from: Path; to: Path; amount: Expr }
  | { op: 'emit'; event: string; data?: Record<string, Expr> };

export interface Rule {
  id: string;
  /** Fires when this action is proposed. Omit for tick rules. */
  when?: { action?: string; tick?: { every: number } };
  /** All must hold, or the action is rejected with this rule's id. */
  require?: Predicate[];
  effects: Effect[];
  /** Higher priority rules evaluate first. Default 0. */
  priority?: number;
  description?: string;
}
