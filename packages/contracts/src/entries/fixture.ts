// Values from the invented Mira Okafor fixture (space "Mira", prefix M, Thursday 12 November 2026),
// shared by the examples. No real data.

export const SPACE_ID = "sp_7c0hq2m4w9d8k1r6t3v5x0b2nf";
export const AS_OF = "1.1046.5n0w8k3q";
export const AS_OF_NEXT = "1.1047.5n0w8k3q";

export const M14 = { id: "t_5m2k8q0w3z7r1c9d4f6h8j0n2p", ref: "M-14" } as const;
export const M15 = { id: "t_7d3n9p1q5s0v2w4x6y8z0a2b4c", ref: "M-15" } as const;
export const M31 = { id: "t_2h6k0m4p8r1t5v9x3z7b1d5f9g", ref: "M-31" } as const;
/** "Fix DST bug in reports", completed on 2026-04-03. */
export const M3 = { id: "t_3a9c7e1g5j2k4m6n8p0q1r3s5t", ref: "M-3" } as const;

export const PORTAL = "/home/mira/work/lumen/portal";

/** One request ID per example, so no two examples share an intent. */
export const requestId = (n: number) =>
  `7f3c2a10-5d4e-4b8a-9c61-2e0f3a7b${String(n).padStart(4, "0")}`;
