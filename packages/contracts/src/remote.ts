// The remote command envelope (A6 3.8.1, the "Remote envelope types" hook of A6 3.3): types only,
// in the registry's type package, exposed by no transport. No entry, route, tool, RPC method or
// generated file names them until linked machines arrive (phase L1), and nothing in v1 parses or
// signs one. They fix the shape now so the execution store, receipts and `receipt.get`'s command ID
// are built against it, not against a guess.

/** What a remote command asks the target to do (A6 3.8.1). */
export type RemoteAction = "open" | "open_folder" | "run" | "routine_run";

/** How long each action's envelope is valid, in seconds; receivers refuse more than 300. */
export const REMOTE_VALIDITY_S: Readonly<Record<RemoteAction, number>> = {
  open: 60,
  open_folder: 60,
  run: 120,
  routine_run: 120,
};

/** The longest validity a receiver accepts, in seconds (A6 3.8.1). */
export const REMOTE_MAX_VALIDITY_S = 300;

/** The most characters `user_text` may hold (A6 3.8.1). */
export const REMOTE_USER_TEXT_MAX = 4000;

/**
 * What the origin device asks and signs. Never an executable, argv, environment, permission flag
 * or absolute path (R10): the target resolves the root and the instance from its own config.
 */
export interface RemoteRequest {
  /** `rc_` and 26 base32 characters. */
  readonly command_id: string;
  readonly space_id: string;
  readonly principal_id: string;
  readonly origin_device: string;
  readonly target_machine: string;
  readonly action: RemoteAction;
  readonly task_id: string;
  /** The place version the device showed. */
  readonly seen_place_version: number;
  /** A4's `root_rev` from the target's last `place.check`. */
  readonly seen_root_rev: number;
  readonly instance_id: string;
  /** At most 4,000 characters, passed to the brief as data, never through a shell (A4). */
  readonly user_text?: string;
  /** ISO 8601 instants. */
  readonly issued_at: string;
  readonly expires_at: string;
}

/** The place the authority derived from its own state, never from the request. */
export type RemotePlace =
  | {
      readonly place_id: string;
      readonly machine_id: string;
      readonly root_id: string;
      readonly rel_path: string;
      /** The newer of the task's place-field version and the place record's (A1). */
      readonly version: number;
    }
  | { readonly kind: "work_folder"; readonly machine_id: string };

/** What the authority binds the request to and countersigns. */
export interface RemoteAuthorization {
  /** `sha256:` and the hash of the request's RFC 8785 canonical JSON. */
  readonly request_hash: string;
  readonly epoch: number;
  readonly incarnation: string;
  readonly as_of_seq: number;
  readonly place: RemotePlace;
  readonly authorized_at: string;
}

/** A remote command as it travels (A6 3.8.1): the signed request and its authorization. */
export interface RemoteEnvelope {
  readonly v: 1;
  readonly type: "remote.execute";
  readonly request: RemoteRequest;
  /** `ed25519:` and the origin device's signature over the request's canonical JSON. */
  readonly origin_sig: string;
  readonly authorization: RemoteAuthorization;
  /** `ed25519:` and the authority's signature over the authorization's canonical JSON. */
  readonly authority_sig: string;
}

/** Why a target refused a command (A6 3.8.3), or why a dispatch failed (A6 3.8.2). */
export type RemoteDenial =
  | "request_reused"
  | "epoch_mismatch"
  | "expired"
  | "clock_skew"
  | "wrong_machine"
  | "denied_by_policy"
  | "desktop_locked"
  | "no_desktop"
  | "executor_unavailable"
  | "place_changed"
  | "place_unresolved"
  | "not_delivered";

/** A target's receipt for a command (A6 3.8.4): A4's outcome, or a denial. */
export type RemoteReceipt =
  | {
      readonly command_id: string;
      readonly outcome: "dispatched" | "confirmed" | "failed" | "unknown";
    }
  | { readonly command_id: string; readonly denied: RemoteDenial };
