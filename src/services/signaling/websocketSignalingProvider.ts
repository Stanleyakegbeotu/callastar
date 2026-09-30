import { SIGNALING } from "@/lib/config";
import { logDiagnostic } from "@/lib/utils";

import {
  SIGNALING_PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  parseServerMessage,
  type CallEndReason,
  type ClientMessage,
  type PresenceState,
  type ServerMessage,
  type SignalDescription,
  type SignalIceCandidate,
  type VideoSourceKind,
} from "./protocol";
import {
  SignalingUnavailableError,
  type InviteCallInput,
  type SignalingCredentials,
  type SignalingListener,
  type SignalingProvider,
  type SignalingStatus,
} from "./provider";

/**
 * Signalling over one WebSocket.
 *
 * Responsibilities kept here, so no call screen has to think about any of them:
 * the hello handshake, reconnection with backoff, a heartbeat that holds presence
 * open, a bounded outbound queue for the moments the socket is down, and
 * validation of every inbound frame.
 *
 * A dropped socket is not a dropped call. Media is peer-to-peer once negotiated,
 * so a conversation can continue perfectly well while this reconnects — which is
 * why losing the socket reports `reconnecting` and keeps trying rather than
 * tearing anything down.
 */

/**
 * How many messages may wait for the socket to come back.
 *
 * Trickle ICE can produce a burst of candidates, and losing them would stall a
 * negotiation that was about to succeed. The cap is what stops a long outage
 * from turning into unbounded memory; the oldest goes first, with a diagnostic.
 */
const MAX_QUEUED_MESSAGES = 64;

/** Nothing is held across a long outage: a stale offer is worse than none. */
const QUEUED_MESSAGE_TTL_MS = 20_000;

interface QueuedMessage {
  message: ClientMessage;
  queuedAt: number;
}

export class WebSocketSignalingProvider implements SignalingProvider {
  private socket: WebSocket | null = null;
  private currentStatus: SignalingStatus = "idle";
  private credentials: SignalingCredentials | null = null;
  private readonly listeners = new Set<SignalingListener>();
  private queue: QueuedMessage[] = [];

  private attempts = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  /** Resolves on hello.ok, rejects when the service refuses the socket. */
  private handshake: { resolve: () => void; reject: (error: Error) => void } | null = null;
  /** Set by `disconnect`, so a deliberate close never schedules a retry. */
  private closing = false;

  constructor(private readonly url: string) {}

  get status(): SignalingStatus {
    return this.currentStatus;
  }

  get configured(): boolean {
    return this.url !== "";
  }

  subscribe(listener: SignalingListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(credentials: SignalingCredentials): Promise<void> {
    if (!this.configured) throw new SignalingUnavailableError();

    // A second connect with the same credentials joins the first rather than
    // opening a competing socket — React effects and StrictMode both do this.
    if (this.socket && this.currentStatus === "open" && this.sameCredentials(credentials)) return;
    if (this.socket) await this.disconnect();

    this.credentials = credentials;
    this.closing = false;
    this.attempts = 0;
    return this.open();
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.clearTimers();
    this.queue = [];

    // Reject an in-flight handshake before the socket goes, so `connect` does
    // not sit unresolved forever.
    this.handshake?.reject(new Error("Signalling closed."));
    this.handshake = null;

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        try {
          socket.close(1000, "client closed");
        } catch (error) {
          logDiagnostic("signaling-close", error);
        }
      }
    }

    this.setStatus("closed");
  }

  /* --------------------------------------------------------------- sending */

  setPresence(profileId: string, presence: PresenceState): Promise<void> {
    return this.send({ type: "presence.update", profileId, presence });
  }

  inviteCall(input: InviteCallInput): Promise<void> {
    return this.send({
      type: "call.invite",
      callAttemptId: input.callAttemptId,
      callIdKey: input.callIdKey,
      callType: input.callType,
      caller: input.caller,
    });
  }

  acceptCall(callAttemptId: string): Promise<void> {
    return this.send({ type: "call.accept", callAttemptId });
  }

  declineCall(callAttemptId: string): Promise<void> {
    return this.send({ type: "call.decline", callAttemptId });
  }

  cancelCall(callAttemptId: string): Promise<void> {
    return this.send({ type: "call.cancel", callAttemptId });
  }

  endCall(callAttemptId: string, reason: CallEndReason): Promise<void> {
    return this.send({ type: "call.end", callAttemptId, reason });
  }

  selectSource(callAttemptId: string, sourceKind: VideoSourceKind, mediaAssetId?: string): Promise<void> {
    return this.send({ type: "call.source_selected", callAttemptId, sourceKind, mediaAssetId });
  }

  markConnected(callAttemptId: string): Promise<void> {
    return this.send({ type: "call.connected", callAttemptId });
  }

  sendDescription(callAttemptId: string, description: SignalDescription): Promise<void> {
    return this.send({ type: "webrtc.description", callAttemptId, description });
  }

  sendIceCandidate(callAttemptId: string, candidate: SignalIceCandidate): Promise<void> {
    return this.send({ type: "webrtc.ice_candidate", callAttemptId, candidate });
  }

  /* ------------------------------------------------------------- internals */

  private sameCredentials(next: SignalingCredentials): boolean {
    const current = this.credentials;
    return (
      current !== null &&
      current.role === next.role &&
      current.token === next.token &&
      current.profileId === next.profileId &&
      current.callIdKey === next.callIdKey
    );
  }

  private open(): Promise<void> {
    const credentials = this.credentials;
    if (!credentials) return Promise.reject(new SignalingUnavailableError());

    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");

    return new Promise<void>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch (error) {
        logDiagnostic("signaling-open", error);
        this.setStatus("failed", "Could not open a connection to CallaStar.");
        reject(error instanceof Error ? error : new Error("Could not open a signalling connection."));
        return;
      }

      this.socket = socket;
      this.handshake = { resolve, reject };

      socket.onopen = () => {
        // The credential goes in the first frame rather than in the URL: a query
        // string lands in proxy logs and browser history, and a token that
        // authorises a call should not be sitting in either.
        this.writeNow({
          type: "hello",
          protocolVersion: SIGNALING_PROTOCOL_VERSION,
          role: credentials.role,
          token: credentials.token,
          profileId: credentials.profileId,
          callIdKey: credentials.callIdKey,
        });
      };

      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (typeof event.data !== "string") return;
        const parsed = decodeFrame(event.data, parseServerMessage);
        if (!parsed.ok) {
          // A frame we cannot understand is dropped, never guessed at.
          logDiagnostic("signaling-invalid-frame", parsed.error);
          return;
        }
        this.handleMessage(parsed.value);
      };

      socket.onerror = (event) => {
        logDiagnostic("signaling-error", event);
      };

      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.stopHeartbeat();

        const handshake = this.handshake;
        this.handshake = null;

        if (this.closing) {
          handshake?.reject(new Error("Signalling closed."));
          return;
        }

        // 4401/4403 are the service refusing this socket outright. Retrying with
        // the same rejected credential would only repeat the refusal.
        const refused = event.code === 4401 || event.code === 4403;
        if (refused) {
          const detail = event.reason || "This call is no longer authorised.";
          this.setStatus("failed", detail);
          handshake?.reject(new Error(detail));
          return;
        }

        if (this.attempts >= SIGNALING.maxReconnectAttempts) {
          const detail = "Lost connection to CallaStar.";
          this.setStatus("failed", detail);
          handshake?.reject(new Error(detail));
          return;
        }

        // The first connect is still awaiting its promise; a later drop is not,
        // so the retry happens quietly behind a `reconnecting` status.
        this.scheduleReconnect(handshake);
      };
    });
  }

  private scheduleReconnect(handshake: { resolve: () => void; reject: (error: Error) => void } | null): void {
    this.attempts += 1;
    this.setStatus("reconnecting");

    // Exponential backoff with jitter, so a service coming back up is not hit by
    // every client at the same instant.
    const base = Math.min(SIGNALING.reconnectBaseMs * 2 ** (this.attempts - 1), SIGNALING.reconnectMaxMs);
    const delay = base / 2 + Math.random() * (base / 2);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.open().then(
        () => handshake?.resolve(),
        (error: unknown) => handshake?.reject(error instanceof Error ? error : new Error("Reconnect failed.")),
      );
    }, delay);
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "hello.ok": {
        this.attempts = 0;
        this.setStatus("open");
        this.startHeartbeat(message.heartbeatMs > 0 ? message.heartbeatMs : SIGNALING.heartbeatMs);
        this.flushQueue();
        const handshake = this.handshake;
        this.handshake = null;
        handshake?.resolve();
        // Still published: a host UI shows that it is connected and available.
        break;
      }

      case "pong":
        // The heartbeat's only job is to keep the socket and presence alive.
        return;

      /**
       * An error only kills the socket when it refused the HANDSHAKE.
       *
       * After hello.ok, `unauthorized` means "not for that call" — a scope check
       * on one message — and the socket is still perfectly usable. Treating that
       * as a transport failure would report "we couldn't reach CallaStar" for
       * what is really a rejected request, sending the caller to check a network
       * that was never the problem. So the escalation is gated on the handshake
       * still being in flight; otherwise the message is simply published.
       */
      case "error":
        if (this.handshake && (message.code === "unauthorized" || message.code === "protocol_version")) {
          const handshake = this.handshake;
          this.handshake = null;
          handshake.reject(new Error(message.message));
          this.setStatus("failed", message.message);
        }
        break;

      default:
        break;
    }

    this.emitMessage(message);
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      // Never queued: a ping that arrives late is worse than one never sent.
      if (this.socket?.readyState === WebSocket.OPEN) this.writeNow({ type: "ping" });
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
  }

  private async send(message: ClientMessage): Promise<void> {
    if (!this.configured) throw new SignalingUnavailableError();

    if (this.currentStatus === "open" && this.socket?.readyState === WebSocket.OPEN) {
      this.writeNow(message);
      return;
    }

    if (this.currentStatus === "failed" || this.currentStatus === "closed") {
      throw new SignalingUnavailableError("Not connected to CallaStar.");
    }

    // Connecting or reconnecting: hold it briefly rather than losing it.
    if (this.queue.length >= MAX_QUEUED_MESSAGES) {
      const dropped = this.queue.shift();
      logDiagnostic("signaling-queue-overflow", dropped?.message.type);
    }
    this.queue.push({ message, queuedAt: Date.now() });
  }

  private writeNow(message: ClientMessage): void {
    try {
      this.socket?.send(encodeFrame(message));
    } catch (error) {
      logDiagnostic("signaling-send", error);
    }
  }

  private flushQueue(): void {
    const now = Date.now();
    const pending = this.queue;
    this.queue = [];

    for (const entry of pending) {
      if (now - entry.queuedAt > QUEUED_MESSAGE_TTL_MS) {
        logDiagnostic("signaling-queue-expired", entry.message.type);
        continue;
      }
      this.writeNow(entry.message);
    }
  }

  private setStatus(status: SignalingStatus, detail?: string): void {
    if (this.currentStatus === status && detail === undefined) return;
    this.currentStatus = status;
    for (const listener of this.listeners) {
      try {
        listener.onStatus?.(status, detail);
      } catch (error) {
        logDiagnostic("signaling-listener", error);
      }
    }
  }

  private emitMessage(message: ServerMessage): void {
    // A copy, so a listener unsubscribing mid-dispatch cannot skip another.
    for (const listener of [...this.listeners]) {
      try {
        listener.onMessage?.(message);
      } catch (error) {
        logDiagnostic("signaling-listener", error);
      }
    }
  }
}
