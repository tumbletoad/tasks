// One setting's changes, sent one at a time. Two requests on two connections can arrive at the
// service either way round, so a change made while one is on its way waits for that answer, and of
// several that wait only the newest is sent: the person's last choice is the one that stands.

export interface Turn<T> {
  /** The service's answer, or undefined when a newer change replaced this one before it was sent. */
  readonly answer: Promise<T | undefined>;
  /** Whether no change was made after this one. */
  readonly newest: () => boolean;
}

export class Turns<T> {
  #ahead: Promise<unknown> = Promise.resolve();
  #open = 0;
  #made = 0;

  take(send: () => Promise<T>): Turn<T> {
    this.#made += 1;
    const mine = this.#made;
    const newest = () => this.#made === mine;
    const go = () => (newest() ? send() : Promise.resolve(undefined));
    // Nothing on its way: it goes at once.
    const answer = this.#open === 0 ? go() : this.#ahead.catch(() => undefined).then(go);
    this.#open += 1;
    this.#ahead = answer;
    answer
      .catch(() => undefined)
      .finally(() => {
        this.#open -= 1;
      });
    return { answer, newest };
  }
}
