import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { adminRepository } from "@/services/admin/repository";

import { analyzeAvatarModel, disposeAvatarScene, type AnalyzedAvatarModel } from "../avatar/modelAnalyzer";
import { SourceAnalyzer, type SourceAnalysisTimings } from "../source/sourceAnalyzer";
import { sourceFromFile, sourceFromStoredAsset, type SourceAsset } from "../source/sourceAsset";
import type {
  SourceAnalysisFailure,
  SourceAnalysisProgress,
  TransformationSourceProfile,
} from "../source/sourceTypes";

/**
 * The Studio's side of source analysis.
 *
 * Orchestration only. Every decision — what a file is, whether a frame is
 * usable, which angles a bank covers, how good the source is — lives in the
 * analysis layer. This hook picks an asset, starts a run, shows progress and
 * owns the preview URL.
 *
 * Independent of the camera by construction: nothing here touches
 * `useStudioRuntime`, and a source can be prepared before a camera has ever
 * been started or a calibration performed.
 */

export type SourceStage = "empty" | "selected" | "analyzing" | "ready" | "failed";

export interface SourceSelectionState {
  stage: SourceStage;
  asset: SourceAsset | null;
  /** Object URL for the preview. Owned and revoked here. */
  previewUrl: string | null;
  progress: SourceAnalysisProgress;
  profile: TransformationSourceProfile | null;
  /**
   * The analysed 3D model, when the chosen source is one.
   *
   * Held beside `profile` rather than inside it: a rigged model and a photograph
   * share almost no measured facts, and forcing them into one shape would give
   * every consumer fields that are null for the other kind.
   */
  avatar: AnalyzedAvatarModel | null;
  failure: SourceAnalysisFailure | null;
  message: string | null;
  /**
   * Confirmed per SOURCE, and reset whenever one is chosen.
   *
   * A confirmation that survived a source change would mean the operator
   * confirmed permission for a file they had not seen.
   */
  consentGiven: boolean;
  timings: SourceAnalysisTimings | null;
}

const IDLE_PROGRESS: SourceAnalysisProgress = { stage: "idle", frame: null, frameCount: null };

export interface SourceSelection extends SourceSelectionState {
  selectFile: (file: File) => Promise<void>;
  selectStoredAsset: (assetId: string, fileName: string) => Promise<void>;
  setConsent: (given: boolean) => void;
  analyze: (consentConfirmed?: boolean) => void;
  cancel: () => void;
  clear: () => void;
}

export function useSourceSelection(profileId: string | null): SourceSelection {
  const [state, setState] = useState<SourceSelectionState>({
    stage: "empty",
    asset: null,
    previewUrl: null,
    progress: IDLE_PROGRESS,
    profile: null,
    avatar: null,
    failure: null,
    message: null,
    consentGiven: false,
    timings: null,
  });

  const analyzerRef = useRef<SourceAnalyzer | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const analyzer = useCallback(() => {
    analyzerRef.current ??= new SourceAnalyzer();
    return analyzerRef.current;
  }, []);

  /** Identifies the model load in flight, so a stale one cannot become live. */
  const avatarTokenRef = useRef(0);
  /** The scene currently held, so it can be released without reading state. */
  const avatarSceneRef = useRef<AnalyzedAvatarModel | null>(null);
  avatarSceneRef.current = state.avatar;

  /** Whoever made the URL revokes it — the ownership rule the app follows. */
  const replacePreview = useCallback((asset: SourceAsset | null): string | null => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = asset ? URL.createObjectURL(asset.blob) : null;
    return previewUrlRef.current;
  }, []);

  useEffect(() => {
    return () => {
      analyzerRef.current?.cancel();
      analyzerRef.current = null;
      // GPU memory is not collected on unmount; the scene has to be released.
      avatarTokenRef.current += 1;
      disposeAvatarScene(avatarSceneRef.current?.scene ?? null);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    };
  }, []);

  /**
   * Choosing a source.
   *
   * Cancels anything running first: an analysis of a file the operator has
   * moved on from is work nobody is waiting for, and its models are memory
   * nobody is using.
   */
  const adopt = useCallback(
    (asset: SourceAsset) => {
      analyzerRef.current?.cancel();
      // Choosing a different source releases the model the last one analysed;
      // `avatar: null` below would otherwise drop the reference and leak the GPU
      // resources behind it.
      avatarTokenRef.current += 1;
      disposeAvatarScene(avatarSceneRef.current?.scene ?? null);
      const previewUrl = replacePreview(asset);

      setState({
        stage: "selected",
        asset,
        previewUrl,
        progress: IDLE_PROGRESS,
        profile: null,
        avatar: null,
        failure: null,
        message: null,
        // Deliberately reset. A new file needs its own confirmation.
        consentGiven: false,
        timings: null,
      });
    },
    [replacePreview],
  );

  const reject = useCallback(
    (message: string) => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
      setState((previous) => ({
        ...previous,
        stage: "failed",
        asset: null,
        previewUrl: null,
        profile: null,
        avatar: null,
        failure: "unsupported-type",
        message,
        consentGiven: false,
      }));
    },
    [],
  );

  const selectFile = useCallback(
    async (file: File) => {
      const asset = await sourceFromFile(file);
      if ("error" in asset) {
        reject(asset.error);
        return;
      }
      adopt(asset);
    },
    [adopt, reject],
  );

  /**
   * An asset the admin already stored.
   *
   * Read through `AdminRepository`, which is the only thing that talks to
   * storage — this does not reach into IndexedDB and does not create a second
   * media library.
   */
  const selectStoredAsset = useCallback(
    async (assetId: string, fileName: string) => {
      const blob = await adminRepository.getAssetBlob(assetId);
      if (!blob) {
        reject("That file could not be read from the media library.");
        return;
      }

      const asset = await sourceFromStoredAsset(assetId, fileName, blob);
      if ("error" in asset) {
        reject(asset.error);
        return;
      }
      adopt(asset);
    },
    [adopt, reject],
  );

  const setConsent = useCallback((given: boolean) => {
    setState((previous) => ({ ...previous, consentGiven: given }));
  }, []);

  const analyze = useCallback((consentConfirmed = false) => {
    const asset = state.asset;
    // Consent is required before the first analysis of a newly supplied source,
    // and there is nothing to analyse without a profile to prepare it for.
    if (!asset || (!state.consentGiven && !consentConfirmed) || !profileId) return;

    setState((previous) => ({
      ...previous,
      consentGiven: previous.consentGiven || consentConfirmed,
      stage: "analyzing",
      progress: { stage: "preparing", frame: null, frameCount: null },
      failure: null,
      message: null,
    }));

    /*
     * A 3D model takes the avatar path.
     *
     * Its own analyser, its own profile, and the same consent, cancel and
     * change-source machinery around it — so adding the mode did not require a
     * second selection hook, and the image and video paths below are untouched.
     */
    if (asset.kind === "3d-model") {
      const token = ++avatarTokenRef.current;
      setState((previous) => ({
        ...previous,
        progress: { stage: "loading-models", frame: null, frameCount: null },
      }));

      void analyzeAvatarModel({
        blob: asset.blob,
        fileName: asset.fileName,
        profileId,
        isStale: () => avatarTokenRef.current !== token,
      }).then((result) => {
        // A model the operator has since replaced must not become the live one,
        // and its GPU resources must not simply be dropped.
        if (avatarTokenRef.current !== token) {
          if (result.ok) disposeAvatarScene(result.model.scene);
          return;
        }

        setState((previous) => {
          if (previous.asset !== asset) {
            if (result.ok) disposeAvatarScene(result.model.scene);
            return previous;
          }

          if (!result.ok) {
            return {
              ...previous,
              stage: result.failure === "cancelled" ? "selected" : "failed",
              avatar: null,
              failure: result.failure === "cancelled" ? "cancelled" : "decode-failed",
              message: result.failure === "cancelled" ? null : result.message,
            };
          }

          // Replacing one analysed model with another releases the first.
          if (previous.avatar) disposeAvatarScene(previous.avatar.scene);
          return { ...previous, stage: "ready", avatar: result.model, failure: null, message: null };
        });
      });
      return;
    }

    const runner = analyzer();
    void runner
      .analyze({
        asset,
        profileId,
        onProgress: (progress) => setState((previous) => ({ ...previous, progress })),
      })
      .then((result) => {
        setState((previous) => {
          // A result for a source the operator has since replaced is discarded.
          if (previous.asset !== asset) return previous;

          return result.ok
            ? {
                ...previous,
                stage: "ready",
                profile: result.profile,
                failure: null,
                message: null,
                timings: runner.getTimings(),
              }
            : {
                ...previous,
                // Cancelling returns to the chosen source rather than an error.
                stage: result.failure === "cancelled" ? "selected" : "failed",
                profile: null,
                failure: result.failure,
                message: result.failure === "cancelled" ? null : result.message,
                timings: runner.getTimings(),
              };
        });
      });
  }, [analyzer, profileId, state.asset, state.consentGiven]);

  const cancel = useCallback(() => {
    analyzerRef.current?.cancel();
    // Abandons a model load in flight too, so its result is discarded on arrival.
    avatarTokenRef.current += 1;
    setState((previous) => ({ ...previous, stage: "selected", progress: IDLE_PROGRESS }));
  }, []);

  /**
   * Change Source.
   *
   * Releases everything this source owned and nothing else. The Studio's
   * runtime — WASM, live models, camera, calibration — is untouched, so
   * changing a source does not cost a 35MB reload.
   */
  const clear = useCallback(() => {
    analyzerRef.current?.cancel();
    // A model load in flight is abandoned, and any analysed scene released.
    avatarTokenRef.current += 1;
    disposeAvatarScene(avatarSceneRef.current?.scene ?? null);
    replacePreview(null);
    setState({
      stage: "empty",
      asset: null,
      previewUrl: null,
      progress: IDLE_PROGRESS,
      profile: null,
      avatar: null,
      failure: null,
      message: null,
      consentGiven: false,
      timings: null,
    });
  }, [replacePreview]);

  return useMemo(
    () => ({ ...state, selectFile, selectStoredAsset, setConsent, analyze, cancel, clear }),
    [state, selectFile, selectStoredAsset, setConsent, analyze, cancel, clear],
  );
}
