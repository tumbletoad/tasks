import { statSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { connect } from "node:tls";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { tempRoot } from "../../test/harness.ts";
import { certPin, LINK_CERT_NAME, makeIdentity, PIN } from "./cert.ts";
import { loadOrCreateHome } from "./home.ts";
import { phoneBatch, phoneTask } from "./rows.ts";
import { isPrivateAddress } from "./service.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe("[S5.link.cert] the link's certificates and the computer's key file", () => {
  test("a certificate of our making reads, verifies, names only `link`, and serves TLS 1.3", async () => {
    const identity = makeIdentity();
    const x509 = new X509Certificate(identity.cert);
    expect(x509.verify(x509.publicKey)).toBe(true);
    expect(x509.subject).toBe(`CN=${LINK_CERT_NAME}`);
    expect(x509.issuer).toBe(`CN=${LINK_CERT_NAME}`);
    expect(x509.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(certPin(identity.cert)).toMatch(PIN);
    const server = createServer({ key: identity.key, cert: identity.cert, minVersion: "TLSv1.3" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const seen = await new Promise<string | undefined>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false });
      socket.once("secureConnect", () => {
        resolve(certPin(socket.getPeerX509Certificate()?.raw ?? Buffer.alloc(0)));
        socket.destroy();
      });
      socket.once("error", reject);
    });
    server.close();
    expect(seen).toBe(certPin(identity.cert));
  });

  test("the key file is made once, private, and made again when it does not read", () => {
    const temp = tempRoot("link-home");
    cleanups.push(temp.cleanup);
    const dir = temp.root;
    const first = loadOrCreateHome(dir);
    expect(loadOrCreateHome(dir).pin).toBe(first.pin);
    if (process.platform !== "win32")
      expect(statSync(join(dir, "link.json")).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, "link.json"), "{}");
    expect(loadOrCreateHome(dir).pin).not.toBe(first.pin);
  });
});

describe("[S5.link.rows] a phone's rows name nothing of the computer", () => {
  test("a task keeps its own fields and loses its place, its last agents and run instances", () => {
    const row = {
      id: "tk_1",
      ref: "M-1",
      title: "Fixture",
      place: { state: "here" as const },
      last: { open: "codex" },
      run: { id: "ru_1", state: "working" as const, instance: "codex" },
      questions: [{ ref: "l1", by: "codex", instance: "codex", text: "Fixture?", at: 1 }],
      some_new_field: "not yet named",
    };
    expect(phoneTask(row)).toEqual({
      id: "tk_1",
      ref: "M-1",
      title: "Fixture",
      run: { id: "ru_1", state: "working" },
      questions: [{ ref: "l1", by: "codex", text: "Fixture?", at: 1 }],
    });
    const batch = phoneBatch({
      type: "batch",
      space_id: "sp",
      epoch: 1,
      incarnation: "a",
      from: 0,
      through: 1,
      events: [
        {
          seq: 1,
          at: 1,
          op_id: "op",
          request_id: "r",
          actor: { kind: "human", label: "user" },
          kind: "task.add",
          entities: [
            { type: "task", id: "tk_1", row, changed: [] },
            { type: "note", id: "n", row: null, changed: [] },
          ],
        },
      ],
    });
    expect(batch.events[0]?.entities[0]?.row).not.toHaveProperty("place");
    expect(batch.events[0]?.entities[1]?.row).toBeNull();
  });

  test("private, link-local and loopback addresses are let in; public ones are not", () => {
    for (const a of [
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.20",
      "100.101.1.2",
      "169.254.1.1",
      "127.0.0.1",
      "::ffff:192.168.0.2",
      "fd12::1",
      "fe80::1",
      "::1",
    ]) {
      expect({ a, ok: isPrivateAddress(a) }).toEqual({ a, ok: true });
    }
    for (const a of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:db8::1", ""]) {
      expect({ a, ok: isPrivateAddress(a) }).toEqual({ a, ok: false });
    }
  });
});
