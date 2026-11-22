// One request of the CLI to the UI listener's port (`ttasks open`'s probe, doctor's self-test),
// bounded the same way every time: one deadline for the whole exchange, from the connect to the
// last byte, and a cap on the bytes read back. Whatever answers on the port may be a squatter,
// so neither a slow trickle of bytes nor an endless body keeps the CLI waiting. Node's own
// `timeout` option is an idle timer, which a trickle resets; it is not used.
import { request, type IncomingHttpHeaders } from "node:http";

export interface ListenerAnswer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface ListenerRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly headers: Readonly<Record<string, string | number>>;
  readonly body?: string;
  /** The whole exchange ends by then: no answer. */
  readonly deadlineMs: number;
  /** A body longer than this: no answer. */
  readonly maxBytes: number;
}

/** The listener's answer, or undefined when it failed, ran past the deadline or was too long. */
export function listenerRequest(
  port: number,
  sent: ListenerRequest,
): Promise<ListenerAnswer | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (answer: ListenerAnswer | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      if (answer === undefined) req.destroy();
      resolve(answer);
    };
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: sent.method,
        path: sent.path,
        agent: false,
        setHost: false,
        headers: sent.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > sent.maxBytes) {
            finish(undefined);
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          finish({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", () => {
          finish(undefined);
        });
      },
    );
    const deadline = setTimeout(() => {
      finish(undefined);
    }, sent.deadlineMs);
    req.on("error", () => {
      finish(undefined);
    });
    req.end(sent.body);
  });
}
