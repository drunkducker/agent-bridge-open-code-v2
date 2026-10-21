/** Tiny bounded Map: insertion/recency ordered, evicts the least recently used entry beyond `cap`. */
export class LruMap<K, V> extends Map<K, V> {
  constructor(readonly cap: number = 1000) {
    super();
  }
  override get(k: K): V | undefined {
    if (!super.has(k)) return undefined;
    const v = super.get(k) as V;
    super.delete(k);
    super.set(k, v);
    return v;
  }
  override set(k: K, v: V): this {
    super.delete(k);
    super.set(k, v);
    while (this.size > this.cap) {
      const oldest = this.keys().next();
      if (oldest.done) break;
      super.delete(oldest.value);
    }
    return this;
  }
}
