export function lru<V>(limit: number) {
  const held = new Map<string, { value: V; weight: number }>();
  let weights = 0;
  return {
    peek(key: string): V | undefined {
      return held.get(key)?.value;
    },
    get(key: string): V | undefined {
      const hit = held.get(key);
      if (!hit) return undefined;
      held.delete(key);
      held.set(key, hit);
      return hit.value;
    },
    set(key: string, value: V, weight: number) {
      held.set(key, { value, weight });
      weights += weight;
      for (const [old, { weight }] of held) {
        if (weights <= limit) break;
        held.delete(old);
        weights -= weight;
      }
    },
  };
}
