import { useCallback, useEffect, useState } from "react";

import { logDiagnostic } from "@/lib/utils";
import { adminRepository } from "@/services/admin/repository";
import type {
  CallEventRecord,
  CallSessionFilters,
  CallSessionRecord,
  HostProfile,
  RemoteVideoRow,
  SessionMetrics,
  StoredAssetMeta,
} from "@/services/admin/types";

/**
 * Data access for the admin screens.
 *
 * Every read goes through the repository, so these hooks are unchanged when
 * Supabase replaces the local engine. IndexedDB is asynchronous, so each hook
 * exposes a real loading and error state rather than pretending reads are
 * instant.
 */

export interface AsyncState<T> {
  data: T;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong reading local data.";
}

export function useAsync<T>(load: () => Promise<T>, initial: T): AsyncState<T> {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    load()
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((cause: unknown) => {
        logDiagnostic("admin-read", cause);
        if (!cancelled) setError(messageOf(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `load` arrives memoised from each hook below, so this runs per query
    // rather than per render.
  }, [load, nonce]);

  return { data, loading, error, reload: useCallback(() => setNonce((value) => value + 1), []) };
}

export function useProfiles(): AsyncState<HostProfile[]> {
  return useAsync(useCallback(() => adminRepository.listProfiles(), []), []);
}

export function useProfile(id: string | undefined): AsyncState<HostProfile | null> {
  return useAsync(
    useCallback(() => (id ? adminRepository.getProfile(id) : Promise.resolve(null)), [id]),
    null,
  );
}

export function useRemoteVideos(): AsyncState<RemoteVideoRow[]> {
  return useAsync(useCallback(() => adminRepository.listRemoteVideos(), []), []);
}

/**
 * Sessions for the CRM list. Status, type, profile and date are narrowed by the
 * repository; search and sort stay in memory where they are cheap.
 */
export function useCallSessions(filters: CallSessionFilters = {}): AsyncState<CallSessionRecord[]> {
  const { status, callType, profileId, since, limit } = filters;
  return useAsync(
    useCallback(
      () => adminRepository.listCallSessions({ status, callType, profileId, since, limit }),
      [callType, limit, profileId, since, status],
    ),
    [],
  );
}

export function useCallSession(sessionId: string | undefined): AsyncState<CallSessionRecord | null> {
  return useAsync(
    useCallback(() => (sessionId ? adminRepository.getCallSession(sessionId) : Promise.resolve(null)), [sessionId]),
    null,
  );
}

export function useCallEvents(sessionId: string | undefined): AsyncState<CallEventRecord[]> {
  return useAsync(
    useCallback(() => (sessionId ? adminRepository.getCallEvents(sessionId) : Promise.resolve([])), [sessionId]),
    [],
  );
}

export function useProfileSessions(profileId: string | undefined, limit?: number): AsyncState<CallSessionRecord[]> {
  return useAsync(
    useCallback(
      () => (profileId ? adminRepository.listProfileSessions(profileId, { limit }) : Promise.resolve([])),
      [limit, profileId],
    ),
    [],
  );
}

export function useSessionMetrics(): AsyncState<SessionMetrics | null> {
  return useAsync(useCallback(() => adminRepository.getSessionMetrics(), []), null);
}

export function useAssetMeta(assetId: string | null): AsyncState<StoredAssetMeta | null> {
  return useAsync(
    useCallback(() => (assetId ? adminRepository.getAssetMeta(assetId) : Promise.resolve(null)), [assetId]),
    null,
  );
}

/**
 * An object URL for one stored asset, revoked when the asset changes or the
 * component unmounts. Blobs are only read here — never while listing profiles.
 */
export function useAssetUrl(assetId: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!assetId) {
      setUrl(null);
      return;
    }

    let cancelled = false;
    let created: string | null = null;

    void adminRepository
      .getAssetBlob(assetId)
      .then((blob) => {
        if (cancelled || !blob) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch((error: unknown) => logDiagnostic("asset-url", error));

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [assetId]);

  return url;
}

/** Preview URL for a file chosen but not yet saved. Revoked on every change. */
export function useFilePreview(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const created = URL.createObjectURL(file);
    setUrl(created);
    return () => {
      URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [file]);

  return url;
}
