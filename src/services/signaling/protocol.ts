/**
 * The signalling wire protocol.
 *
 * Shared, verbatim, by the browser and by `server/signaling` — the server
 * re-exports this module rather than keeping a second copy, because a protocol
 * that drifts between the two ends is a class of bug nobody can see.
 *
 * Deliberately dependency-free: no `@/` imports, no DOM types, no config. It has
 * to be loadable in Node as easily as in a bundle.
 *
 * Signalling carries call control and the SDP/ICE needed to negotiate a direct
 * path. It never carries media: not a frame, not a sample. Once a peer
 * connection is up, the conversation itself does not pass through this server.
 *
 * Every message crossing this boundary is validated. `parseClientMessage` and
 * `parseServerMessage` are the only sanctioned ways in — nothing anywhere should
 * cast raw JSON to these types, because the far end is not trusted. On the
 * server the far end is the public internet; in the browser it is a socket that
 * might have been fed by anything.
 */

/** Wire-protocol version. A mismatched client is refused rather than guessed at. */
export const SIGNALING_PROTOCOL_VERSION = 1;

/**
 * Is somebody actually there to answer?
 *
 * Deliberately not the same thing as a profile being Active. Active is an
 * operator's setting and survives the browser closing; presence is a live socket
 * and does not. A host must be both to receive a call.
 */
export type PresenceState = "offline" | "available" | "ringing" | "busy";

/**
 * How a host appears to the caller.
 *
 * `filter-core` is reserved: the transform does not exist yet and no UI offers
 * it. It is named here so the protocol does not have to change when it lands.
 */
export type VideoSourceKind = "live-camera" | "uploaded-source" | "filter-core";

/**
 * Why a call finished.
 *
 * `subscription_required` is a product decision, not a fault, and the host's
 * screen has to say so — "Network failed" would send an operator chasing a
 * problem that does not exist.
 */
export type CallEndReason =
  | "hangup"
  | "declined"
  | "no_answer"
  | "busy"
  | "cancelled"
  | "subscription_required"
  | "source_selection_timeout"
  | "connection_lost"
  | "transport_closed";

/** Which side of a call a socket is on. Decides what it may do and see. */
export type CallRole = "guest" | "host";

/** What the guest asked for. A host may only answer video from a phone. */
export type SignalCallType = "video" | "audio";

/**
 * The caller, as the host's incoming-call screen needs them.
 *
 * Name only. Email and phone are collected by the join form and belong in the
 * session record; they are not put on the wire so that a socket cannot be used
 * to harvest contact details.
 */
export interface SignalCaller {
  displayName: string;
}

export interface SignalDescription {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp: string;
}

export interface SignalIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

/* ------------------------------------------------------------------ limits */

/**
 * Ceilings, enforced on parse.
 *
 * An SDP with a long candidate list is a few kilobytes; 64KB is generous. The
 * point is that a socket cannot be used to push megabytes through the server.
 */
const LIMITS = {
  id: 128,
  displayName: 120,
  callIdCode: 64,
  sdp: 64 * 1024,
  candidate: 2 * 1024,
  token: 4 * 1024,
  reason: 64,
} as const;

/* -------------------------------------------------------- client → server */

/**
 * First message on every socket, and the only one accepted before it.
 *
 * A guest presents the ephemeral token issued when their Call ID was resolved,
 * which authorises exactly one call attempt. A host presents its operator
 * credential. A Call ID is never a credential: knowing one lets you ring a
 * profile, not act as it.
 */
export interface HelloMessage {
  type: "hello";
  protocolVersion: number;
  role: CallRole;
  /** Guest: the ephemeral call token. Host: the operator session token. */
  token: string;
  /** Host only: which profile this socket is operating. */
  profileId?: string;
  /**
   * Host only: the normalised Call ID this socket answers for.
   *
   * The service keeps no profile database — profiles live in the operator's own
   * storage — so a host registers the code it is reachable on and the service is
   * a pure rendezvous. It therefore cannot leak which Call IDs exist: a code no
   * host has registered and a code that was never real are indistinguishable.
   */
  callIdKey?: string;
}

export interface PresenceUpdateMessage {
  type: "presence.update";
  profileId: string;
  presence: PresenceState;
}

export interface CallInviteMessage {
  type: "call.invite";
  callAttemptId: string;
  /** Normalised Call ID the guest dialled. The server resolves it to a profile. */
  callIdKey: string;
  callType: SignalCallType;
  caller: SignalCaller;
}

export interface CallAcceptMessage {
  type: "call.accept";
  callAttemptId: string;
}

export interface CallDeclineMessage {
  type: "call.decline";
  callAttemptId: string;
}

/** The guest gave up before the host answered. */
export interface CallCancelMessage {
  type: "call.cancel";
  callAttemptId: string;
}

/**
 * Which source the host chose, sent as metadata only.
 *
 * `mediaAssetId` is an opaque reference. The server resolves it to a short-lived
 * authorised playback URL; a browser never puts a storage URL on the wire,
 * because a URL minted by one client is not something the other should trust.
 */
export interface CallSourceSelectedMessage {
  type: "call.source_selected";
  callAttemptId: string;
  sourceKind: VideoSourceKind;
  mediaAssetId?: string;
}

/** Media is flowing. Lets the other side retire its connecting UI. */
export interface CallConnectedMessage {
  type: "call.connected";
  callAttemptId: string;
}

export interface CallEndMessage {
  type: "call.end";
  callAttemptId: string;
  reason: CallEndReason;
}

export interface WebrtcDescriptionMessage {
  type: "webrtc.description";
  callAttemptId: string;
  description: SignalDescription;
}

export interface WebrtcIceCandidateMessage {
  type: "webrtc.ice_candidate";
  callAttemptId: string;
  candidate: SignalIceCandidate;
}

export interface PingMessage {
  type: "ping";
  /** Echoed back in the pong, so a client can match them up. */
  nonce?: string;
}

export type ClientMessage =
  | HelloMessage
  | PresenceUpdateMessage
  | CallInviteMessage
  | CallAcceptMessage
  | CallDeclineMessage
  | CallCancelMessage
  | CallSourceSelectedMessage
  | CallConnectedMessage
  | CallEndMessage
  | WebrtcDescriptionMessage
  | WebrtcIceCandidateMessage
  | PingMessage;

/* -------------------------------------------------------- server → client */

export interface HelloOkMessage {
  type: "hello.ok";
  protocolVersion: number;
  role: CallRole;
  /** This socket, for diagnostics. Not a credential and not reusable. */
  connectionId: string;
  /** How often the client should ping to hold presence open. */
  heartbeatMs: number;
}

/**
 * Something was refused.
 *
 * `code` is a closed set so the UI can react without reading prose, and the
 * prose is operator-facing. Nothing here reveals whether an arbitrary Call ID
 * exists: an unknown profile and an inactive one both answer `call_unavailable`.
 */
export type SignalErrorCode =
  | "protocol_version"
  | "unauthorized"
  | "invalid_message"
  | "rate_limited"
  | "call_unavailable"
  | "host_offline"
  | "host_busy"
  | "attempt_unknown"
  | "internal";

export interface ErrorMessage {
  type: "error";
  code: SignalErrorCode;
  message: string;
  /** Set when the failure belongs to one call attempt rather than the socket. */
  callAttemptId?: string;
}

/** A ring nobody answered. Closes the host's incoming screen. */
export interface CallNoAnswerMessage {
  type: "call.no_answer";
  callAttemptId: string;
}

/** The host is already on another call. */
export interface CallBusyMessage {
  type: "call.busy";
  callAttemptId: string;
}

/**
 * Relayed to the host with the profile attached, so a socket operating several
 * profiles knows which one is being rung.
 */
export interface IncomingCallMessage {
  type: "call.incoming";
  callAttemptId: string;
  profileId: string;
  callType: SignalCallType;
  caller: SignalCaller;
  /** Epoch ms the ring started, so both ends time out together. */
  ringingSince: number;
  /** Epoch ms the ring expires. */
  ringExpiresAt: number;
}

/**
 * The host chose a source, with the reference already resolved.
 *
 * `playbackUrl` is minted by the server and short-lived. It is absent when the
 * selected asset is not reachable from another device, which is the honest
 * answer while call sources live only in the operator's own browser storage.
 */
export interface SourceSelectedMessage {
  type: "call.source_ready";
  callAttemptId: string;
  sourceKind: VideoSourceKind;
  playbackUrl?: string;
  playbackExpiresAt?: number;
  /** Set when a source was chosen but cannot be delivered, and why. */
  unavailableReason?: "not_uploaded" | "storage_unreachable";
}

export interface PongMessage {
  type: "pong";
  nonce?: string;
}

export type ServerMessage =
  | HelloOkMessage
  | ErrorMessage
  | PresenceUpdateMessage
  | IncomingCallMessage
  | CallAcceptMessage
  | CallDeclineMessage
  | CallCancelMessage
  | CallBusyMessage
  | CallNoAnswerMessage
  | SourceSelectedMessage
  | CallConnectedMessage
  | CallEndMessage
  | WebrtcDescriptionMessage
  | WebrtcIceCandidateMessage
  | PongMessage;

export type SignalMessage = ClientMessage | ServerMessage;

/* -------------------------------------------------------------- validation */

/**
 * Hand-written, because the repository has no schema library and the protocol is
 * small enough not to justify adding one. `features/join-call/validation.ts`
 * validates the join form the same way.
 *
 * The contract is total: every parser returns a result, none of them throw, and
 * a failure says which field was wrong without echoing its contents back.
 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fail<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string within its limit. */
function text(source: Record<string, unknown>, key: string, max: number): string | null {
  const value = source[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) return null;
  return trimmed;
}

function optionalText(source: Record<string, unknown>, key: string, max: number): string | null | undefined {
  if (source[key] === undefined || source[key] === null) return undefined;
  return text(source, key, max);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

const PRESENCE_STATES: readonly PresenceState[] = ["offline", "available", "ringing", "busy"];
const SOURCE_KINDS: readonly VideoSourceKind[] = ["live-camera", "uploaded-source", "filter-core"];
const CALL_TYPES: readonly SignalCallType[] = ["video", "audio"];
const DESCRIPTION_TYPES: readonly SignalDescription["type"][] = ["offer", "answer", "pranswer", "rollback"];
const END_REASONS: readonly CallEndReason[] = [
  "hangup",
  "declined",
  "no_answer",
  "busy",
  "cancelled",
  "subscription_required",
  "source_selection_timeout",
  "connection_lost",
  "transport_closed",
];

function parseDescription(value: unknown): SignalDescription | null {
  if (!isRecord(value)) return null;
  const type = oneOf(value.type, DESCRIPTION_TYPES);
  if (!type) return null;
  // Only a rollback legitimately carries no SDP.
  const sdp = value.sdp;
  if (typeof sdp !== "string" || sdp.length > LIMITS.sdp) return null;
  if (sdp === "" && type !== "rollback") return null;
  return { type, sdp };
}

function parseCandidate(value: unknown): SignalIceCandidate | null {
  if (!isRecord(value)) return null;
  // An empty candidate string is the end-of-candidates signal, so it is valid.
  const candidate = value.candidate;
  if (typeof candidate !== "string" || candidate.length > LIMITS.candidate) return null;

  const sdpMid = value.sdpMid;
  if (sdpMid !== null && sdpMid !== undefined && typeof sdpMid !== "string") return null;

  const index = value.sdpMLineIndex;
  if (index !== null && index !== undefined && !Number.isInteger(index)) return null;

  const fragment = value.usernameFragment;
  if (fragment !== null && fragment !== undefined && typeof fragment !== "string") return null;

  return {
    candidate,
    sdpMid: typeof sdpMid === "string" ? sdpMid : null,
    sdpMLineIndex: Number.isInteger(index) ? (index as number) : null,
    usernameFragment: typeof fragment === "string" ? fragment : null,
  };
}

function parseCaller(value: unknown): SignalCaller | null {
  if (!isRecord(value)) return null;
  const displayName = text(value, "displayName", LIMITS.displayName);
  return displayName ? { displayName } : null;
}

/** Every call-scoped message needs an attempt id and nothing else in common. */
function attemptId(source: Record<string, unknown>): string | null {
  return text(source, "callAttemptId", LIMITS.id);
}

export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  if (!isRecord(raw)) return fail("Message must be an object.");
  const type = raw.type;
  if (typeof type !== "string") return fail("Message is missing a type.");

  switch (type) {
    case "hello": {
      if (!Number.isInteger(raw.protocolVersion)) return fail("hello is missing protocolVersion.");
      const role = oneOf(raw.role, ["guest", "host"] as const);
      if (!role) return fail("hello has an unknown role.");
      const token = text(raw, "token", LIMITS.token);
      if (!token) return fail("hello is missing a token.");
      const profileId = optionalText(raw, "profileId", LIMITS.id);
      if (profileId === null) return fail("hello has an invalid profileId.");
      const callIdKey = optionalText(raw, "callIdKey", LIMITS.callIdCode);
      if (callIdKey === null) return fail("hello has an invalid callIdKey.");
      // A host operates a named profile; a guest is scoped by its token alone.
      if (role === "host" && profileId === undefined) return fail("A host hello needs a profileId.");
      return {
        ok: true,
        value: {
          type: "hello",
          protocolVersion: raw.protocolVersion as number,
          role,
          token,
          profileId,
          callIdKey,
        },
      };
    }

    case "presence.update": {
      const profileId = text(raw, "profileId", LIMITS.id);
      if (!profileId) return fail("presence.update is missing a profileId.");
      const presence = oneOf(raw.presence, PRESENCE_STATES);
      if (!presence) return fail("presence.update has an unknown presence.");
      return { ok: true, value: { type: "presence.update", profileId, presence } };
    }

    case "call.invite": {
      const callAttemptId = attemptId(raw);
      if (!callAttemptId) return fail("call.invite is missing a callAttemptId.");
      const callIdKey = text(raw, "callIdKey", LIMITS.callIdCode);
      if (!callIdKey) return fail("call.invite is missing a callIdKey.");
      const callType = oneOf(raw.callType, CALL_TYPES);
      if (!callType) return fail("call.invite has an unknown callType.");
      const caller = parseCaller(raw.caller);
      if (!caller) return fail("call.invite has invalid caller details.");
      return { ok: true, value: { type: "call.invite", callAttemptId, callIdKey, callType, caller } };
    }

    case "call.accept":
    case "call.decline":
    case "call.cancel":
    case "call.connected": {
      const callAttemptId = attemptId(raw);
      if (!callAttemptId) return fail(`${type} is missing a callAttemptId.`);
      return { ok: true, value: { type, callAttemptId } };
    }

    case "call.source_selected": {
      const callAttemptId = attemptId(raw);
      if (!callAttemptId) return fail("call.source_selected is missing a callAttemptId.");
      const sourceKind = oneOf(raw.sourceKind, SOURCE_KINDS);
      if (!sourceKind) return fail("call.source_selected has an unknown sourceKind.");
      const mediaAssetId = optionalText(raw, "mediaAssetId", LIMITS.id);
      if (mediaAssetId === null) return fail("call.source_selected has an invalid mediaAssetId.");
      return { ok: true, value: { type: "call.source_selected", callAttemptId, sourceKind, mediaAssetId } };
    }

    case "call.end": {
      const callAttemptId = attemptId(raw);
      if (!callAttemptId) return fail("call.end is missing a callAttemptId.");
      const reason = oneOf(raw.reason, END_REASONS);
      if (!reason) return fail("call.end has an unknown reason.");
      return { ok: true, value: { type: "call.end", callAttemptId, reason } };
    }

    case "webrtc.description": {
      const callAttemptId = attemptId(raw);
      if (!callAttemptId) return fail("webrtc.description is missing a callAttemptId.");
      const description = parseDescription(raw.description);
      if (!description) return fail("webrtc.description has an invalid description.");
      return { ok: true, value: { type: "webrtc.description", callAttemptId, description } };
    }

    case "webrtc.ice_candidate": {
      const callAttemptId = attemptId(raw);
      if (!callAttemptId) return fail("webrtc.ice_candidate is missing a callAttemptId.");
      const candidate = parseCandidate(raw.candidate);
      if (!candidate) return fail("webrtc.ice_candidate has an invalid candidate.");
      return { ok: true, value: { type: "webrtc.ice_candidate", callAttemptId, candidate } };
    }

    case "ping": {
      const nonce = optionalText(raw, "nonce", LIMITS.id);
      if (nonce === null) return fail("ping has an invalid nonce.");
      return { ok: true, value: { type: "ping", nonce } };
    }

    default:
      return fail(`Unknown message type: ${type.slice(0, 40)}`);
  }
}

export function parseServerMessage(raw: unknown): ParseResult<ServerMessage> {
  if (!isRecord(raw)) return fail("Message must be an object.");
  const type = raw.type;
  if (typeof type !== "string") return fail("Message is missing a type.");

  switch (type) {
    case "hello.ok": {
      if (!Number.isInteger(raw.protocolVersion)) return fail("hello.ok is missing protocolVersion.");
      const role = oneOf(raw.role, ["guest", "host"] as const);
      if (!role) return fail("hello.ok has an unknown role.");
      const connectionId = text(raw, "connectionId", LIMITS.id);
      if (!connectionId) return fail("hello.ok is missing a connectionId.");
      const heartbeatMs = Number.isFinite(raw.heartbeatMs) ? (raw.heartbeatMs as number) : 0;
      return {
        ok: true,
        value: {
          type: "hello.ok",
          protocolVersion: raw.protocolVersion as number,
          role,
          connectionId,
          heartbeatMs,
        },
      };
    }

    case "error": {
      const code = oneOf(raw.code, [
        "protocol_version",
        "unauthorized",
        "invalid_message",
        "rate_limited",
        "call_unavailable",
        "host_offline",
        "host_busy",
        "attempt_unknown",
        "internal",
      ] as const);
      if (!code) return fail("error has an unknown code.");
      const message = text(raw, "message", 400) ?? "";
      const callAttemptId = optionalText(raw, "callAttemptId", LIMITS.id);
      if (callAttemptId === null) return fail("error has an invalid callAttemptId.");
      return { ok: true, value: { type: "error", code, message, callAttemptId } };
    }

    case "presence.update": {
      const profileId = text(raw, "profileId", LIMITS.id);
      if (!profileId) return fail("presence.update is missing a profileId.");
      const presence = oneOf(raw.presence, PRESENCE_STATES);
      if (!presence) return fail("presence.update has an unknown presence.");
      return { ok: true, value: { type: "presence.update", profileId, presence } };
    }

    case "call.incoming": {
      const callAttemptId = attemptId(raw);
      if (!callAttemptId) return fail("call.incoming is missing a callAttemptId.");
      const profileId = text(raw, "profileId", LIMITS.id);
      if (!profileId) return fail("call.incoming is missing a profileId.");
      const callType = oneOf(raw.callType, CALL_TYPES);
      if (!callType) return fail("call.incoming has an unknown callType.");
      const caller = parseCaller(raw.caller);
      if (!caller) return fail("call.incoming has invalid caller details.");
      const ringingSince = Number.isFinite(raw.ringingSince) ? (raw.ringingSince as number) : Date.now();
      const ringExpiresAt = Number.isFinite(raw.ringExpiresAt) ? (raw.ringExpiresAt as number) : 0;
      return {
        ok: true,
        value: { type: "call.incoming", callAttemptId, profileId, callType, caller, ringingSince, ringExpiresAt },
      };
    }

    case "call.accept":
    case "call.decline":
    case "call.cancel":
    case "call.busy":
    case "call.no_answer":
    case "call.connected": {
      const callAttemptId = attemptId(raw);
      if (!callAttemptId) return fail(`${type} is missing a callAttemptId.`);
      return { ok: true, value: { type, callAttemptId } };
    }

    case "call.source_ready": {
      const callAttemptId = attemptId(raw);
      if (!callAttemptId) return fail("call.source_ready is missing a callAttemptId.");
      const sourceKind = oneOf(raw.sourceKind, SOURCE_KINDS);
      if (!sourceKind) return fail("call.source_ready has an unknown sourceKind.");
      const playbackUrl = optionalText(raw, "playbackUrl", 4096);
      if (playbackUrl === null) return fail("call.source_ready has an invalid playbackUrl.");
      const unavailableReason = oneOf(raw.unavailableReason, ["not_uploaded", "storage_unreachable"] as const);
      const playbackExpiresAt = Number.isFinite(raw.playbackExpiresAt)
        ? (raw.playbackExpiresAt as number)
        : undefined;
      return {
        ok: true,
        value: {
          type: "call.source_ready",
          callAttemptId,
          sourceKind,
          playbackUrl,
          playbackExpiresAt,
          unavailableReason: unavailableReason ?? undefined,
        },
      };
    }

    case "call.end": {
      const callAttemptId = attemptId(raw);
      if (!callAttemptId) return fail("call.end is missing a callAttemptId.");
      const reason = oneOf(raw.reason, END_REASONS);
      if (!reason) return fail("call.end has an unknown reason.");
      return { ok: true, value: { type: "call.end", callAttemptId, reason } };
    }

    case "webrtc.description": {
      const callAttemptId = attemptId(raw);
      if (!callAttemptId) return fail("webrtc.description is missing a callAttemptId.");
      const description = parseDescription(raw.description);
      if (!description) return fail("webrtc.description has an invalid description.");
      return { ok: true, value: { type: "webrtc.description", callAttemptId, description } };
    }

    case "webrtc.ice_candidate": {
      const callAttemptId = attemptId(raw);
      if (!callAttemptId) return fail("webrtc.ice_candidate is missing a callAttemptId.");
      const candidate = parseCandidate(raw.candidate);
      if (!candidate) return fail("webrtc.ice_candidate has an invalid candidate.");
      return { ok: true, value: { type: "webrtc.ice_candidate", callAttemptId, candidate } };
    }

    case "pong": {
      const nonce = optionalText(raw, "nonce", LIMITS.id);
      if (nonce === null) return fail("pong has an invalid nonce.");
      return { ok: true, value: { type: "pong", nonce } };
    }

    default:
      return fail(`Unknown message type: ${type.slice(0, 40)}`);
  }
}

/** Parses a socket frame. JSON failures are a protocol error, never a throw. */
export function decodeFrame<T>(raw: string, parse: (value: unknown) => ParseResult<T>): ParseResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail("Frame is not valid JSON.");
  }
  return parse(value);
}

export function encodeFrame(message: SignalMessage): string {
  return JSON.stringify(message);
}
