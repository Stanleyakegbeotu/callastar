import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";

import { config } from "./config.ts";
import { perSecond } from "./rateLimit.ts";
import {
  SIGNALING_PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  parseClientMessage,
  type CallEndReason,
  type ClientMessage,
  type PresenceState,
  type ServerMessage,
  type SignalCallType,
  type SignalCaller,
  type SignalErrorCode,
} from "./protocol.ts";
import { verifyGuestToken, verifyHostToken, type GuestClaims } from "./tokens.ts";

/**
 * The rendezvous.
 *
 * Holds no durable state and no profile database: profiles live in the
 * operator's own storage, so a host registers the Call ID it answers for and
 * this service only introduces two sockets to each other. That has a useful
 * consequence for privacy — a code no host has registered and a code that was
 * never real are indistinguishable from outside, so this cannot be used to
 * enumerate which Call IDs exist.
 *
 * It relays call control and SDP/ICE. Media never passes through it: once a peer
 * connection is up the conversation is directly between the two phones.
 */

/* ------------------------------------------------------------------ sockets */

type SocketRole = "guest" | "host";

interface BaseSocket {
  id: string;
  ws: WebSocket;
  role: SocketRole;
  /** Last frame from this socket. Presence expiry is measured from here. */
  lastSeen: number;
  /** Per-socket message budget, so one client cannot flood the service. */
  budget: ReturnType<typeof perSecond>;
}

interface GuestSocket extends BaseSocket {
  role: "guest";
  claims: GuestClaims;
}

interface HostSocket extends BaseSocket {
  role: "host";
  profileId: string;
  callIdKey: string;
  presence: PresenceState;
}

type Socket = GuestSocket | HostSocket;

/* ------------------------------------------------------------------ attempts */

type AttemptState = "ringing" | "accepted" | "connected";

interface Attempt {
  id: string;
  callType: SignalCallType;
  caller: SignalCaller;
  guest: GuestSocket;
  host: HostSocket;
  state: AttemptState;
  ringTimer: NodeJS.Timeout | null;
}

export class SignalingHub {
  /** Every authenticated socket, by its own id. */
  private readonly sockets = new Map<string, Socket>();
  /** Hosts by the Call ID they answer for. One host per code. */
  private readonly hostsByCallId = new Map<string, HostSocket>();
  private readonly attempts = new Map<string, Attempt>();
  /** Sockets that have connected but not yet said hello. */
  private readonly pending = new Set<WebSocket>();

  private sweepTimer: NodeJS.Timeout | null = null;

  start(): void {
    // Presence is server-authoritative: a host that stops sending frames stops
    // being available, whether or not it managed to say so on the way out.
    this.sweepTimer = setInterval(() => this.sweep(), Math.max(5_000, config.heartbeatMs / 2));
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const socket of this.sockets.values()) this.closeSocket(socket.ws, 1001, "service stopping");
  }

  /* ------------------------------------------------------------- connection */

  accept(ws: WebSocket): void {
    this.pending.add(ws);

    // A socket that never authenticates is not allowed to sit there. The window
    // is short because hello is the client's very first frame.
    const helloDeadline = setTimeout(() => {
      if (this.pending.has(ws)) this.closeSocket(ws, 4401, "no hello");
    }, 10_000);

    ws.on("message", (data: unknown) => {
      const raw = typeof data === "string" ? data : String(data);
      this.onFrame(ws, raw);
    });

    ws.on("close", () => {
      clearTimeout(helloDeadline);
      this.pending.delete(ws);
      this.onDisconnect(ws);
    });

    ws.on("error", () => {
      clearTimeout(helloDeadline);
      this.pending.delete(ws);
      this.onDisconnect(ws);
    });

    ws.on("pong", () => {
      const socket = this.findByWs(ws);
      if (socket) socket.lastSeen = Date.now();
    });
  }

  private onFrame(ws: WebSocket, raw: string): void {
    // Never trusted. Every frame is validated before anything reads a field.
    const parsed = decodeFrame(raw, parseClientMessage);
    if (!parsed.ok) {
      this.sendRaw(ws, { type: "error", code: "invalid_message", message: parsed.error });
      return;
    }

    const message = parsed.value;
    const socket = this.findByWs(ws);

    if (!socket) {
      // Before hello, the only acceptable frame is hello.
      if (message.type !== "hello") {
        this.sendRaw(ws, { type: "error", code: "unauthorized", message: "Say hello first." });
        this.closeSocket(ws, 4401, "unauthenticated");
        return;
      }
      this.onHello(ws, message);
      return;
    }

    socket.lastSeen = Date.now();

    // The bucket is already per socket, so its own id is the only key it needs.
    if (!socket.budget.take(socket.id)) {
      this.send(socket, { type: "error", code: "rate_limited", message: "Too many messages." });
      return;
    }

    if (message.type === "hello") {
      // One handshake per socket. A second is a client bug, not a re-auth.
      this.send(socket, { type: "error", code: "invalid_message", message: "Already authenticated." });
      return;
    }

    this.route(socket, message);
  }

  private onHello(ws: WebSocket, message: Extract<ClientMessage, { type: "hello" }>): void {
    if (message.protocolVersion !== SIGNALING_PROTOCOL_VERSION) {
      this.sendRaw(ws, {
        type: "error",
        code: "protocol_version",
        message: `This service speaks protocol ${SIGNALING_PROTOCOL_VERSION}.`,
      });
      this.closeSocket(ws, 4403, "protocol version");
      return;
    }

    const id = `conn_${randomUUID()}`;
    const budget = perSecond(config.limits.messagesPerSecond);

    if (message.role === "guest") {
      const verified = verifyGuestToken(message.token);
      if (!verified.ok) {
        // Deliberately one message for every failure: a client has no business
        // learning whether a token was forged, malformed or merely stale.
        this.sendRaw(ws, { type: "error", code: "unauthorized", message: "This call is no longer authorised." });
        this.closeSocket(ws, 4401, "bad guest token");
        return;
      }

      const socket: GuestSocket = {
        id,
        ws,
        role: "guest",
        lastSeen: Date.now(),
        budget,
        claims: verified.claims,
      };
      this.register(socket);
      this.send(socket, {
        type: "hello.ok",
        protocolVersion: SIGNALING_PROTOCOL_VERSION,
        role: "guest",
        connectionId: id,
        heartbeatMs: config.heartbeatMs,
      });
      return;
    }

    if (!verifyHostToken(message.token)) {
      this.sendRaw(ws, { type: "error", code: "unauthorized", message: "Not authorised to operate a profile." });
      this.closeSocket(ws, 4401, "bad host token");
      return;
    }

    const profileId = message.profileId;
    const callIdKey = message.callIdKey;
    if (!profileId || !callIdKey) {
      this.sendRaw(ws, {
        type: "error",
        code: "invalid_message",
        message: "A host must name the profile and Call ID it answers for.",
      });
      this.closeSocket(ws, 4403, "incomplete host hello");
      return;
    }

    // One host per Call ID. A second replaces the first, which is what happens
    // when an operator moves from their laptop to their phone — the stale socket
    // must not keep receiving that profile's calls.
    const existing = this.hostsByCallId.get(callIdKey);
    if (existing) {
      this.closeSocket(existing.ws, 4403, "replaced by a newer host session");
    }

    const socket: HostSocket = {
      id,
      ws,
      role: "host",
      lastSeen: Date.now(),
      budget,
      profileId,
      callIdKey,
      // Registering is not the same as being available: the operator still has
      // to turn Receive Calls on, which arrives as a presence.update.
      presence: "offline",
    };

    this.register(socket);
    this.hostsByCallId.set(callIdKey, socket);
    this.send(socket, {
      type: "hello.ok",
      protocolVersion: SIGNALING_PROTOCOL_VERSION,
      role: "host",
      connectionId: id,
      heartbeatMs: config.heartbeatMs,
    });
  }

  private register(socket: Socket): void {
    this.pending.delete(socket.ws);
    this.sockets.set(socket.id, socket);
  }

  /* ----------------------------------------------------------------- routing */

  private route(socket: Socket, message: Exclude<ClientMessage, { type: "hello" }>): void {
    switch (message.type) {
      case "ping":
        this.send(socket, { type: "pong", nonce: message.nonce });
        return;

      case "presence.update":
        this.onPresence(socket, message.profileId, message.presence);
        return;

      case "call.invite":
        this.onInvite(socket, message.callAttemptId, message.callIdKey, message.callType, message.caller);
        return;

      case "call.accept":
        this.onAccept(socket, message.callAttemptId);
        return;

      case "call.decline":
        this.onDecline(socket, message.callAttemptId);
        return;

      case "call.cancel":
        this.onCancel(socket, message.callAttemptId);
        return;

      case "call.end":
        this.onEnd(socket, message.callAttemptId, message.reason);
        return;

      case "call.source_selected":
        this.onSourceSelected(socket, message.callAttemptId, message.sourceKind, message.mediaAssetId);
        return;

      case "call.connected":
        this.onConnected(socket, message.callAttemptId);
        return;

      case "webrtc.description":
      case "webrtc.ice_candidate": {
        // The negotiation itself: relayed verbatim to the other side and never
        // inspected. The service has no business reading an SDP.
        const attempt = this.authorizedAttempt(socket, message.callAttemptId);
        if (!attempt) return;
        this.send(this.peerOf(attempt, socket), message);
        return;
      }
    }
  }

  private onPresence(socket: Socket, profileId: string, presence: PresenceState): void {
    if (socket.role !== "host") {
      this.send(socket, { type: "error", code: "unauthorized", message: "Only a host sets presence." });
      return;
    }
    if (socket.profileId !== profileId) {
      this.send(socket, { type: "error", code: "unauthorized", message: "That is not this socket's profile." });
      return;
    }

    // `ringing` and `busy` are the service's to assign — they follow from a call
    // actually existing. An operator may only say available or offline.
    if (presence !== "available" && presence !== "offline") {
      this.send(socket, { type: "error", code: "invalid_message", message: "Set available or offline." });
      return;
    }

    // Never drop a live call because a stray toggle arrived.
    if (socket.presence === "busy" || socket.presence === "ringing") return;

    socket.presence = presence;
    this.send(socket, { type: "presence.update", profileId, presence });
  }

  private onInvite(
    socket: Socket,
    callAttemptId: string,
    callIdKey: string,
    callType: SignalCallType,
    caller: SignalCaller,
  ): void {
    if (socket.role !== "guest") {
      this.send(socket, { type: "error", code: "unauthorized", message: "Only a guest invites." });
      return;
    }

    // The token is what authorises this, and it authorises exactly one attempt
    // against exactly one Call ID. A guest cannot redirect it at another host.
    if (socket.claims.callAttemptId !== callAttemptId || socket.claims.callIdKey !== callIdKey) {
      this.send(socket, {
        type: "error",
        code: "unauthorized",
        message: "This token does not authorise that call.",
        callAttemptId,
      });
      return;
    }

    if (this.attempts.has(callAttemptId)) {
      // A retransmitted invite, most likely. The ring is already in progress.
      return;
    }

    const host = this.hostsByCallId.get(callIdKey);

    // An unregistered code and an unknown one answer identically. Anything else
    // would turn this endpoint into a way to test whether a Call ID is real.
    if (!host || host.presence === "offline") {
      this.fail(socket, "host_offline", "This host is not available right now.", callAttemptId);
      return;
    }

    if (host.presence === "busy" || host.presence === "ringing") {
      this.send(socket, { type: "call.busy", callAttemptId });
      return;
    }

    const attempt: Attempt = {
      id: callAttemptId,
      callType,
      caller,
      guest: socket,
      host,
      state: "ringing",
      ringTimer: null,
    };

    host.presence = "ringing";
    this.attempts.set(callAttemptId, attempt);

    const now = Date.now();
    const ringExpiresAt = now + config.ringTimeoutMs;

    // Both ends get the same deadline, so neither has to guess when the other
    // gave up. The server still enforces it on its own clock below.
    this.send(host, {
      type: "call.incoming",
      callAttemptId,
      profileId: host.profileId,
      callType,
      caller,
      ringingSince: now,
      ringExpiresAt,
    });

    attempt.ringTimer = setTimeout(() => {
      const current = this.attempts.get(callAttemptId);
      if (!current || current.state !== "ringing") return;
      this.send(current.guest, { type: "call.no_answer", callAttemptId });
      this.send(current.host, { type: "call.no_answer", callAttemptId });
      this.finish(current, "available");
    }, config.ringTimeoutMs);
  }

  private onAccept(socket: Socket, callAttemptId: string): void {
    const attempt = this.authorizedAttempt(socket, callAttemptId);
    if (!attempt) return;
    if (socket.role !== "host" || attempt.state !== "ringing") return;

    this.clearRingTimer(attempt);
    attempt.state = "accepted";
    attempt.host.presence = "busy";
    // The caller stops hearing a ring and starts seeing "Connecting…" from here,
    // even though the host has still to choose how they want to appear.
    this.send(attempt.guest, { type: "call.accept", callAttemptId });
  }

  private onDecline(socket: Socket, callAttemptId: string): void {
    const attempt = this.authorizedAttempt(socket, callAttemptId);
    if (!attempt || socket.role !== "host") return;

    this.send(attempt.guest, { type: "call.decline", callAttemptId });
    this.finish(attempt, "available");
  }

  private onCancel(socket: Socket, callAttemptId: string): void {
    const attempt = this.authorizedAttempt(socket, callAttemptId);
    if (!attempt || socket.role !== "guest") return;

    this.send(attempt.host, { type: "call.cancel", callAttemptId });
    this.finish(attempt, "available");
  }

  private onConnected(socket: Socket, callAttemptId: string): void {
    const attempt = this.authorizedAttempt(socket, callAttemptId);
    if (!attempt) return;
    attempt.state = "connected";
    this.send(this.peerOf(attempt, socket), { type: "call.connected", callAttemptId });
  }

  private onEnd(socket: Socket, callAttemptId: string, reason: CallEndReason): void {
    const attempt = this.authorizedAttempt(socket, callAttemptId);
    if (!attempt) return;

    // Relayed with its reason intact. `subscription_required` in particular has
    // to reach the host as itself: showing an operator "Network failed" would
    // send them looking for a fault that does not exist.
    this.send(this.peerOf(attempt, socket), { type: "call.end", callAttemptId, reason });
    this.finish(attempt, "available");
  }

  /**
   * The host chose how to appear.
   *
   * An uploaded source has to be resolved to a URL the OTHER phone can open, and
   * this service has no media storage — so it says so, plainly, rather than
   * relaying a reference the guest could never fetch. Wiring object storage is
   * what turns `storage_unreachable` into a signed URL here.
   */
  private onSourceSelected(
    socket: Socket,
    callAttemptId: string,
    sourceKind: "live-camera" | "uploaded-source" | "filter-core",
    mediaAssetId: string | undefined,
  ): void {
    const attempt = this.authorizedAttempt(socket, callAttemptId);
    if (!attempt || socket.role !== "host") return;

    if (sourceKind === "live-camera") {
      this.send(attempt.guest, { type: "call.source_ready", callAttemptId, sourceKind });
      return;
    }

    this.send(attempt.guest, {
      type: "call.source_ready",
      callAttemptId,
      sourceKind,
      unavailableReason: mediaAssetId ? "storage_unreachable" : "not_uploaded",
    });
  }

  /* -------------------------------------------------------------- lifecycle */

  /**
   * The attempt this socket is allowed to act on, or nothing.
   *
   * A guest is scoped to the single attempt its token names; a host to attempts
   * on its own socket. This is what stops a socket touching somebody else's call
   * by guessing an id.
   */
  private authorizedAttempt(socket: Socket, callAttemptId: string): Attempt | null {
    const attempt = this.attempts.get(callAttemptId);
    if (!attempt) {
      this.send(socket, {
        type: "error",
        code: "attempt_unknown",
        message: "That call is no longer in progress.",
        callAttemptId,
      });
      return null;
    }

    const belongs = socket.role === "guest" ? attempt.guest.id === socket.id : attempt.host.id === socket.id;
    if (!belongs) {
      this.send(socket, {
        type: "error",
        code: "unauthorized",
        message: "Not a participant in that call.",
        callAttemptId,
      });
      return null;
    }

    return attempt;
  }

  private peerOf(attempt: Attempt, socket: Socket): Socket {
    return socket.role === "guest" ? attempt.host : attempt.guest;
  }

  private clearRingTimer(attempt: Attempt): void {
    if (attempt.ringTimer) clearTimeout(attempt.ringTimer);
    attempt.ringTimer = null;
  }

  /** Retires an attempt and hands the host back to the presence it should have. */
  private finish(attempt: Attempt, hostPresence: PresenceState): void {
    this.clearRingTimer(attempt);
    this.attempts.delete(attempt.id);

    const host = attempt.host;
    if (this.sockets.has(host.id)) {
      host.presence = hostPresence;
      this.send(host, { type: "presence.update", profileId: host.profileId, presence: hostPresence });
    }

    // A guest token is good for one call. With the attempt over, the socket has
    // nothing left it may do, so it is closed rather than left open.
    this.closeSocket(attempt.guest.ws, 1000, "call finished");
  }

  private onDisconnect(ws: WebSocket): void {
    const socket = this.findByWs(ws);
    if (!socket) return;

    this.sockets.delete(socket.id);

    if (socket.role === "host") {
      // Only if this is still the registered host: a replaced socket closing must
      // not deregister the one that replaced it.
      if (this.hostsByCallId.get(socket.callIdKey)?.id === socket.id) {
        this.hostsByCallId.delete(socket.callIdKey);
      }
    }

    // Whatever this socket was part of is over. The other side is told, so it
    // shows an ended call rather than waiting on somebody who has gone.
    for (const attempt of [...this.attempts.values()]) {
      if (attempt.guest.id !== socket.id && attempt.host.id !== socket.id) continue;
      const peer = attempt.guest.id === socket.id ? attempt.host : attempt.guest;
      this.send(peer, { type: "call.end", callAttemptId: attempt.id, reason: "transport_closed" });
      this.clearRingTimer(attempt);
      this.attempts.delete(attempt.id);
      if (peer.role === "host" && this.sockets.has(peer.id)) {
        peer.presence = "available";
        this.send(peer, { type: "presence.update", profileId: peer.profileId, presence: "available" });
      }
    }
  }

  /**
   * Expires anything that has gone quiet.
   *
   * This is what makes presence trustworthy. A host whose phone lost signal, or
   * whose tab was closed without a clean close frame, disappears here — so no
   * caller ever rings a host who is not there.
   */
  private sweep(): void {
    const now = Date.now();

    for (const socket of [...this.sockets.values()]) {
      if (now - socket.lastSeen <= config.presenceTimeoutMs) {
        // A ping the client must answer; the pong updates lastSeen.
        try {
          socket.ws.ping();
        } catch {
          this.closeSocket(socket.ws, 1001, "ping failed");
        }
        continue;
      }
      this.closeSocket(socket.ws, 1001, "presence timed out");
      this.onDisconnect(socket.ws);
    }
  }

  /* ------------------------------------------------------------------ output */

  private findByWs(ws: WebSocket): Socket | null {
    for (const socket of this.sockets.values()) {
      if (socket.ws === ws) return socket;
    }
    return null;
  }

  private fail(socket: Socket, code: SignalErrorCode, message: string, callAttemptId?: string): void {
    this.send(socket, { type: "error", code, message, callAttemptId });
  }

  private send(socket: Socket, message: ServerMessage): void {
    this.sendRaw(socket.ws, message);
  }

  private sendRaw(ws: WebSocket, message: ServerMessage): void {
    try {
      if (ws.readyState === 1) ws.send(encodeFrame(message));
    } catch {
      // A socket we cannot write to is a socket that is going away anyway.
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      try {
        ws.terminate();
      } catch {
        // Nothing further to do: the socket is unusable either way.
      }
    }
  }

  /* ------------------------------------------------------- lookups for HTTP */

  /**
   * Whether a Call ID has an available host right now.
   *
   * Used by the authorize endpoint so a token is only ever minted for a call
   * that could actually connect. It returns a state, never a profile — the
   * caller learns whether they can ring, and nothing about who they are ringing.
   */
  hostAvailability(callIdKey: string): "available" | "busy" | "unavailable" {
    const host = this.hostsByCallId.get(callIdKey);
    if (!host || host.presence === "offline") return "unavailable";
    if (host.presence === "busy" || host.presence === "ringing") return "busy";
    return "available";
  }

  stats(): { sockets: number; hosts: number; attempts: number } {
    return { sockets: this.sockets.size, hosts: this.hostsByCallId.size, attempts: this.attempts.size };
  }
}
