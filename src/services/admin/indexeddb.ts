import { logDiagnostic } from "@/lib/utils";

/**
 * A very small promise wrapper over IndexedDB.
 *
 * Native rather than a dependency: the local engine needs four stores and a
 * handful of operations, which is not enough boilerplate to justify pulling in
 * a library. Everything here is generic plumbing — the CallaStar rules live in
 * `localAdminRepository.ts`.
 */

export const DB_NAME = "callastar-development";
export const DB_VERSION = 5;

export const STORE_PROFILES = "profiles";
/** File metadata, separate from the bytes so lists never pull a video into memory. */
export const STORE_ASSETS = "assets";
/** The bytes themselves, keyed by the same id as their metadata record. */
export const STORE_BLOBS = "blobs";
export const STORE_SESSIONS = "sessions";
/** Lifecycle events for a session, one row per meaningful transition. */
export const STORE_EVENTS = "callEvents";
/* Version 3: subscriptions, customer care and admin notifications. */
export const STORE_PLANS = "subscriptionPlans";
export const STORE_REQUESTS = "subscriptionRequests";
export const STORE_GRANTS = "subscriptionGrants";
export const STORE_CONVERSATIONS = "supportConversations";
export const STORE_MESSAGES = "supportMessages";
/** Attachment metadata; the bytes live in STORE_BLOBS beside call media. */
export const STORE_SUPPORT_ASSETS = "supportAssets";
export const STORE_NOTIFICATIONS = "adminNotifications";
/* Version 4: operator-editable application settings, one row keyed "global". */
export const STORE_SETTINGS = "appSettings";
/* Version 5: issued access credentials, and what this browser has already used. */
export const STORE_ACCESS_IDS = "subscriptionAccessIds";
export const STORE_PREVIEW_ACCESS = "previewAccess";

export type StorageErrorKind = "quota" | "unsupported" | "blocked" | "unknown";

/** A failure worth showing a person, with the raw cause kept for the console. */
export class AdminStorageError extends Error {
  readonly kind: StorageErrorKind;

  constructor(kind: StorageErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "AdminStorageError";
    this.kind = kind;
    if (cause !== undefined) logDiagnostic("admin-storage", cause);
  }
}

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

export function toStorageError(cause: unknown): AdminStorageError {
  if (cause instanceof AdminStorageError) return cause;

  const name = cause instanceof Error ? cause.name : "";
  if (name === "QuotaExceededError") {
    return new AdminStorageError(
      "quota",
      "Local development storage is full. Remove or replace existing media, or use a smaller video.",
      cause,
    );
  }

  return new AdminStorageError("unknown", "Local development storage could not complete that change.", cause);
}

/** How long to wait for a connection before calling the store unavailable. */
const OPEN_TIMEOUT_MS = 8000;

let databasePromise: Promise<IDBDatabase> | null = null;
let documentIsHidden = false;

/**
 * Hand the store back when this document goes away.
 *
 * A connection held by a page that is being torn down can block the page that
 * replaces it, which shows up as an open that never completes. Closing on
 * `pagehide` keeps navigation clean; `pageshow` covers a restore from the
 * back/forward cache, where the next call simply reopens.
 */
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    documentIsHidden = true;
    const pending = databasePromise;
    databasePromise = null;
    void pending?.then((db) => db.close()).catch(() => undefined);
  });
  window.addEventListener("pageshow", () => {
    documentIsHidden = false;
  });
}

/** The shape sessions had in version 1, kept only so they can be migrated. */
interface LegacySessionRecord {
  id: string;
  profileId: string;
  profileName: string;
  callType: "video" | "audio";
  callerName?: string;
  callerEmail?: string;
  status: string;
  startedAt?: string;
  endedAt: string | null;
  durationSeconds: number | null;
}

/**
 * Carry a version 1 session into the richer version 2 shape.
 *
 * Version 1 only knew when a call started and ended, so the finer timestamps
 * are inferred conservatively: a call that reached active is treated as having
 * connected when it started, and anything unknown stays null rather than being
 * invented.
 */
function migrateSession(legacy: LegacySessionRecord): Record<string, unknown> {
  const createdAt = legacy.startedAt ?? new Date(0).toISOString();
  const connected = legacy.status === "active" || (legacy.status === "ended" && legacy.durationSeconds !== null);

  return {
    id: legacy.id,
    profileId: legacy.profileId,
    profileName: legacy.profileName,
    callIdSnapshot: "",
    callType: legacy.callType,
    caller: { fullName: legacy.callerName ?? "", email: legacy.callerEmail ?? "", phone: "" },
    status: legacy.status,
    createdAt,
    connectingAt: createdAt,
    ringingAt: null,
    connectedAt: connected ? createdAt : null,
    endedAt: legacy.endedAt,
    failureCode: null,
    durationSeconds: legacy.durationSeconds,
  };
}

/**
 * Upgrades are additive: stores and indexes are created only when missing, and
 * existing rows are migrated in place, so bumping DB_VERSION never discards the
 * profiles and media somebody created.
 */
function upgrade(db: IDBDatabase, oldVersion: number, transaction: IDBTransaction | null): void {
  if (!db.objectStoreNames.contains(STORE_PROFILES)) {
    const profiles = db.createObjectStore(STORE_PROFILES, { keyPath: "id" });
    profiles.createIndex("by_call_id_key", "callIdKey", { unique: true });
    profiles.createIndex("by_created_at", "createdAt");
  }

  if (!db.objectStoreNames.contains(STORE_ASSETS)) {
    const assets = db.createObjectStore(STORE_ASSETS, { keyPath: "id" });
    assets.createIndex("by_profile", "profileId");
    assets.createIndex("by_kind", "kind");
  }

  if (!db.objectStoreNames.contains(STORE_BLOBS)) {
    db.createObjectStore(STORE_BLOBS);
  }

  if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
    const sessions = db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
    sessions.createIndex("by_profile", "profileId");
    sessions.createIndex("by_status", "status");
    sessions.createIndex("by_created_at", "createdAt");
    sessions.createIndex("by_call_type", "callType");
  } else if (oldVersion < 2 && transaction) {
    // Version 1 indexed sessions by a field that no longer exists.
    const sessions = transaction.objectStore(STORE_SESSIONS);
    if (sessions.indexNames.contains("by_started_at")) sessions.deleteIndex("by_started_at");
    if (!sessions.indexNames.contains("by_profile")) sessions.createIndex("by_profile", "profileId");
    if (!sessions.indexNames.contains("by_status")) sessions.createIndex("by_status", "status");
    if (!sessions.indexNames.contains("by_created_at")) sessions.createIndex("by_created_at", "createdAt");
    if (!sessions.indexNames.contains("by_call_type")) sessions.createIndex("by_call_type", "callType");

    sessions.openCursor().onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (!cursor) return;
      const value = cursor.value as LegacySessionRecord & { caller?: unknown };
      if (value.caller === undefined) cursor.update(migrateSession(value));
      cursor.continue();
    };
  }

  if (!db.objectStoreNames.contains(STORE_EVENTS)) {
    const events = db.createObjectStore(STORE_EVENTS, { keyPath: "id" });
    events.createIndex("by_session", "sessionId");
    events.createIndex("by_occurred_at", "occurredAt");
  }

  // Version 3 adds stores only: profiles, media, sessions and events are
  // untouched, so an existing local workspace keeps everything in it.
  if (!db.objectStoreNames.contains(STORE_PLANS)) {
    db.createObjectStore(STORE_PLANS, { keyPath: "id" });
  }

  if (!db.objectStoreNames.contains(STORE_REQUESTS)) {
    const requests = db.createObjectStore(STORE_REQUESTS, { keyPath: "id" });
    requests.createIndex("by_email", "customerEmailNormalized");
    requests.createIndex("by_session", "sessionId");
    requests.createIndex("by_status", "status");
    requests.createIndex("by_created_at", "createdAt");
    requests.createIndex("by_plan", "planId");
  }

  if (!db.objectStoreNames.contains(STORE_GRANTS)) {
    const grants = db.createObjectStore(STORE_GRANTS, { keyPath: "id" });
    grants.createIndex("by_session", "sessionId");
    grants.createIndex("by_request", "requestId");
    grants.createIndex("by_email", "customerEmailNormalized");
    grants.createIndex("by_consumed_by", "consumedBySessionId");
  } else if (transaction) {
    // Version 4: a grant now belongs to a customer and is claimed by one
    // session, so a confirmed subscription can be used by the NEXT call rather
    // than only by the call it was requested from. Indexes are added in place;
    // rows written by version 3 keep their values and are treated as already
    // claimed by the session they were granted for.
    const grants = transaction.objectStore(STORE_GRANTS);
    if (!grants.indexNames.contains("by_email")) grants.createIndex("by_email", "customerEmailNormalized");
    if (!grants.indexNames.contains("by_consumed_by")) grants.createIndex("by_consumed_by", "consumedBySessionId");
  }

  if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
    const conversations = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: "id" });
    conversations.createIndex("by_email", "customerEmailNormalized");
    conversations.createIndex("by_status", "status");
    conversations.createIndex("by_updated_at", "updatedAt");
    conversations.createIndex("by_request", "subscriptionRequestId");
  }

  if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
    const messages = db.createObjectStore(STORE_MESSAGES, { keyPath: "id" });
    messages.createIndex("by_conversation", "conversationId");
    messages.createIndex("by_created_at", "createdAt");
    messages.createIndex("by_sender", "sender");
  }

  if (!db.objectStoreNames.contains(STORE_SUPPORT_ASSETS)) {
    const assets = db.createObjectStore(STORE_SUPPORT_ASSETS, { keyPath: "id" });
    assets.createIndex("by_conversation", "conversationId");
  }

  if (!db.objectStoreNames.contains(STORE_NOTIFICATIONS)) {
    const notifications = db.createObjectStore(STORE_NOTIFICATIONS, { keyPath: "id" });
    notifications.createIndex("by_created_at", "createdAt");
    notifications.createIndex("by_type", "type");
    notifications.createIndex("by_read", "readAt");
  }

  // Version 4 adds a single settings row. Like every upgrade before it this
  // creates a store and nothing else, so profiles, media, sessions, events,
  // plans, requests, grants, conversations, messages and notifications all
  // survive untouched.
  if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
    db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
  }

  /*
   * Version 5. Two stores, again added and nothing else touched.
   *
   * Access credentials are indexed by their hash, never by the code itself —
   * looking one up is a hash comparison, so the plaintext need not be stored
   * to be resolved. `previewAccess` is keyed by profile because storage is
   * already scoped to this browser and this site; no identifier for the person
   * is needed or kept.
   */
  if (!db.objectStoreNames.contains(STORE_ACCESS_IDS)) {
    const access = db.createObjectStore(STORE_ACCESS_IDS, { keyPath: "id" });
    access.createIndex("by_code_hash", "codeHash", { unique: true });
    access.createIndex("by_profile", "profileId");
    access.createIndex("by_plan", "planId");
    access.createIndex("by_status", "status");
    access.createIndex("by_created_at", "createdAt");
    access.createIndex("by_request", "subscriptionRequestId");
  }

  if (!db.objectStoreNames.contains(STORE_PREVIEW_ACCESS)) {
    db.createObjectStore(STORE_PREVIEW_ACCESS, { keyPath: "profileId" });
  }
}

export function openDatabase(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(
      new AdminStorageError("unsupported", "This browser cannot store local development data (IndexedDB is unavailable)."),
    );
  }

  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      /**
       * An open that never settles would leave the UI on a spinner for good.
       * It happens when a previous document was torn down mid-open and the
       * store is still locked, so this fails loudly and stays retryable.
       */
      const timer = window.setTimeout(() => {
        reject(
          new AdminStorageError(
            "blocked",
            "Local development storage did not respond. Close other CallaStar tabs and reload; if it keeps happening, restart the browser.",
          ),
        );
      }, OPEN_TIMEOUT_MS);

      request.onupgradeneeded = (event) => upgrade(request.result, event.oldVersion, request.transaction);
      request.onsuccess = () => {
        window.clearTimeout(timer);
        // The document is already going away: release the store rather than
        // holding a connection that would block the next page.
        if (documentIsHidden) {
          request.result.close();
          databasePromise = null;
          reject(new AdminStorageError("blocked", "The page was closing before local storage finished opening."));
          return;
        }

        // A later tab opening a newer version must not be left waiting on us.
        request.result.onversionchange = () => {
          request.result.close();
          databasePromise = null;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        window.clearTimeout(timer);
        reject(toStorageError(request.error));
      };
      request.onblocked = () => {
        window.clearTimeout(timer);
        reject(new AdminStorageError("blocked", "Another CallaStar tab is using local storage. Close it and try again."));
      };
    }).catch((error: unknown) => {
      databasePromise = null;
      throw toStorageError(error);
    });
  }

  return databasePromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export interface TransactionScope {
  store(name: string): IDBObjectStore;
  get<T>(name: string, key: IDBValidKey): Promise<T | undefined>;
  getAll<T>(name: string, query?: IDBKeyRange | IDBValidKey | null): Promise<T[]>;
  getAllFromIndex<T>(name: string, index: string, query: IDBKeyRange | IDBValidKey): Promise<T[]>;
  put(name: string, value: unknown, key?: IDBValidKey): Promise<void>;
  remove(name: string, key: IDBValidKey): Promise<void>;
}

/**
 * Run work inside one transaction.
 *
 * The callback may only await the promises handed to it; awaiting anything else
 * lets the transaction auto-close between requests. Every caller here obeys
 * that, which is what makes multi-store writes (profile + asset + blob) atomic.
 */
export async function runTransaction<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  work: (scope: TransactionScope) => Promise<T> | T,
): Promise<T> {
  const db = await openDatabase();

  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(storeNames, mode);
    } catch (error) {
      reject(toStorageError(error));
      return;
    }

    let result: T;
    let settled = false;

    const scope: TransactionScope = {
      store: (name) => transaction.objectStore(name),
      get: <V,>(name: string, key: IDBValidKey) => promisify<V | undefined>(transaction.objectStore(name).get(key)),
      getAll: <V,>(name: string, query?: IDBKeyRange | IDBValidKey | null) =>
        promisify<V[]>(transaction.objectStore(name).getAll(query ?? undefined)),
      getAllFromIndex: <V,>(name: string, index: string, query: IDBKeyRange | IDBValidKey) =>
        promisify<V[]>(transaction.objectStore(name).index(index).getAll(query)),
      put: (name, value, key) =>
        promisify(transaction.objectStore(name).put(value as never, key)).then(() => undefined),
      remove: (name, key) => promisify(transaction.objectStore(name).delete(key)).then(() => undefined),
    };

    transaction.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    transaction.onerror = () => {
      if (!settled) {
        settled = true;
        reject(toStorageError(transaction.error));
      }
    };
    transaction.onabort = () => {
      if (!settled) {
        settled = true;
        reject(toStorageError(transaction.error));
      }
    };

    Promise.resolve()
      .then(() => work(scope))
      .then((value) => {
        result = value;
      })
      .catch((error: unknown) => {
        if (!settled) {
          settled = true;
          reject(toStorageError(error));
        }
        try {
          transaction.abort();
        } catch {
          // Already finished; nothing to roll back.
        }
      });
  });
}

/** Development helper: drop everything this engine owns. Never called by the UI. */
export async function clearLocalDatabase(): Promise<void> {
  const stores = [
    STORE_PROFILES,
    STORE_ASSETS,
    STORE_BLOBS,
    STORE_SESSIONS,
    STORE_EVENTS,
    STORE_PLANS,
    STORE_REQUESTS,
    STORE_GRANTS,
    STORE_CONVERSATIONS,
    STORE_MESSAGES,
    STORE_SUPPORT_ASSETS,
    STORE_NOTIFICATIONS,
    STORE_SETTINGS,
    STORE_ACCESS_IDS,
    STORE_PREVIEW_ACCESS,
  ];
  await runTransaction(stores, "readwrite", (scope) => {
    scope.store(STORE_PROFILES).clear();
    scope.store(STORE_ASSETS).clear();
    scope.store(STORE_BLOBS).clear();
    scope.store(STORE_SESSIONS).clear();
    scope.store(STORE_EVENTS).clear();
    for (const name of stores.slice(5)) scope.store(name).clear();
  });
}
