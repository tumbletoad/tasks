// Refetches that race: a feed event asks again while an earlier read is still on its way, and the
// answers can arrive in any order. Only the answer to the newest request for a key may apply. It
// started after the newest event, so it holds everything the older ones would have shown.

/** Per-key request generations. `begin` returns whether that request is still the newest. */
export class Latest {
  readonly #generation = new Map<string, number>();

  begin(key: string): () => boolean {
    const mine = (this.#generation.get(key) ?? 0) + 1;
    this.#generation.set(key, mine);
    return () => this.#generation.get(key) === mine;
  }
}
