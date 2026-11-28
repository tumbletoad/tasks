// Settings > Phones without React: the service's answers read by their shape, and the pairing
// code drawn as a QR code. The code holds a one-use secret, so it is drawn and never put in the
// page's address, its storage or a log.
import { encode } from "uqr";
import type { Api } from "../api.ts";

/** A paired phone, as the service lists it (link/service.ts PhoneView). */
export interface Phone {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly space: string;
  readonly spaceName: string | null;
  readonly pairedAt: string;
  readonly lastUsedAt: string | null;
  readonly run: boolean;
}

/** What became of the code a dialog shows. */
export type Pairing =
  | { readonly state: "waiting" }
  | { readonly state: "paired"; readonly phone: string }
  | { readonly state: "ended" };

export interface PhonesView {
  readonly phones: readonly Phone[];
  readonly pairing?: Pairing;
}

/** A new code: its text for the QR code, and the ticket the dialog follows it by. */
export interface PhoneCode {
  readonly code: string;
  readonly ticket: string;
  readonly expiresAt: string;
  /** How many of this computer's addresses the code names; none: no phone can reach it. */
  readonly addresses: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

export function readPhones(value: unknown): PhonesView {
  const record = isRecord(value) ? value : {};
  const phones = (Array.isArray(record["phones"]) ? record["phones"] : [])
    .filter(isRecord)
    .map((p): Phone => ({
      id: text(p["id"]),
      name: text(p["name"]),
      platform: text(p["platform"]),
      space: text(p["space"]),
      spaceName: typeof p["space_name"] === "string" ? p["space_name"] : null,
      pairedAt: text(p["paired_at"]),
      lastUsedAt: typeof p["last_used_at"] === "string" ? p["last_used_at"] : null,
      run: p["run"] === true,
    }))
    .filter((p) => p.id !== "");
  const pairing = record["pairing"];
  if (!isRecord(pairing)) return { phones };
  const state = pairing["state"];
  if (state === "paired") return { phones, pairing: { state, phone: text(pairing["phone"]) } };
  if (state === "waiting") return { phones, pairing: { state } };
  return { phones, pairing: { state: "ended" } };
}

export function readCode(value: unknown): PhoneCode {
  const record = isRecord(value) ? value : {};
  return {
    code: text(record["code"]),
    ticket: text(record["ticket"]),
    expiresAt: text(record["expires_at"]),
    addresses: typeof record["addresses"] === "number" ? record["addresses"] : 0,
  };
}

/** The QR code of `data` as one SVG path in a square of `size` modules, quiet zone included. */
export function qrPath(data: string): { size: number; d: string } {
  const qr = encode(data, { ecc: "M", border: 4 });
  const parts: string[] = [];
  qr.data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${String(x)} ${String(y)}h1v1h-1z`);
    });
  });
  return { size: qr.size, d: parts.join("") };
}

/** The page's calls for Settings > Phones. */
export const phoneCalls = (api: Api) => ({
  view: async (ticket?: string) =>
    readPhones(await api.machineCall("phones", ticket === undefined ? {} : { ticket })),
  pair: async (space: string) => readCode(await api.machineCall("phone_pair", { space })),
  end: (ticket: string) => api.machineCall("phone_pair", { end: ticket }),
  run: (phone: string, run: boolean) => api.machineCall("phone_rights", { phone, run }),
  remove: (phone: string) => api.machineCall("phone_remove", { phone }),
});
