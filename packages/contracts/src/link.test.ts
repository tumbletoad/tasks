// The QR code's text as the phone reads it: what the service makes parses, anything else is refused
// before the phone connects anywhere.
import { describe, expect, test } from "vitest";
import { LINK_PROTOCOL, PAIRING_PREFIX, parsePairing } from "./link.ts";

const PIN = "A".repeat(43);
const good = {
  v: LINK_PROTOCOL,
  addrs: ["192.168.1.20:7740", "100.100.1.2:7740"],
  pin: PIN,
  space: { id: "sp_1", name: "Home" },
  code: "c0de",
};
const text = (value: unknown) => `${PAIRING_PREFIX}${JSON.stringify(value)}`;

describe("[S5.link.qr] the phone reads a pairing code and refuses anything else", () => {
  test("a code as the service makes it reads back whole", () => {
    expect(parsePairing(text(good))).toEqual(good);
  });

  test.each([
    ["no prefix", JSON.stringify(good)],
    ["a URL", `https://example.invalid/?${PAIRING_PREFIX}`],
    ["not JSON", `${PAIRING_PREFIX}{`],
    ["another version", text({ ...good, v: 2 })],
    ["no address", text({ ...good, addrs: [] })],
    ["an address without a port", text({ ...good, addrs: ["192.168.1.20"] })],
    ["a short pin", text({ ...good, pin: "A".repeat(42) })],
    ["no space ID", text({ ...good, space: { id: "", name: "Home" } })],
    ["no code", text({ ...good, code: "" })],
  ])("%s is not a pairing code", (_label, value) => {
    expect(parsePairing(value)).toBeUndefined();
  });
});
