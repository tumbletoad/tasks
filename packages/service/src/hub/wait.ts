// Every wait in the hub has a bound (A2 3.3.1, 3.4).

export class Timeout extends Error {
  override readonly name = "Timeout";
  readonly code = "ETIMEDOUT";
  constructor() {
    super("timed out");
  }
}

/** `work`, or a Timeout after `ms`. The work may still finish later; its timer never lingers. */
export async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Timeout());
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `work` settled within `ms`. Its outcome is not looked at. */
export const within = (work: Promise<unknown>, ms: number): Promise<boolean> =>
  bounded(work, ms).then(
    () => true,
    (error: unknown) => !(error instanceof Timeout),
  );
