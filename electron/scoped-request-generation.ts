export function advanceScopedRequest<Scope>(
  generations: Map<Scope, number>,
  scope: Scope
): number {
  const generation = (generations.get(scope) ?? 0) + 1
  generations.set(scope, generation)
  return generation
}

export function scopedRequestIsCurrent<Scope>(
  generations: ReadonlyMap<Scope, number>,
  scope: Scope,
  generation: number
): boolean {
  return generations.get(scope) === generation
}
