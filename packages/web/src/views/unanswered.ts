import { requestId } from "../api.ts";

/**
 * The requests that got no answer, by what they are for (a task's Run, a task and app's Open):
 * what each asked and its request ID. The same request again carries that ID, so the service gives
 * back what the first one made, if it made anything, instead of making a second.
 */
export class Unanswered {
  readonly #kept = new Map<string, { readonly asked: string; readonly id: string }>();

  /**
   * The ID of a request for `key` that asks `asked`: the unanswered one's, else a new one, which
   * is kept until the service answers it, so the same request while it is on its way is that one.
   */
  idFor(key: string, asked: string): string {
    const before = this.#kept.get(key);
    if (before?.asked === asked) return before.id;
    const id = requestId();
    this.#kept.set(key, { asked, id });
    return id;
  }

  /** The service answered for `key`: the next request is a new one. */
  answered(key: string): void {
    this.#kept.delete(key);
  }
}
