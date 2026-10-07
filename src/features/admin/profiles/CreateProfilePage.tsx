import { useRef, useState } from "react";
import { productionDiagnostic } from "@/lib/productionDiagnostics";
import { Link, useNavigate } from "react-router-dom";

import { adminRepository } from "@/services/admin/repository";

import { useToast } from "../components/ToastProvider";
import { AdminPageHeader } from "../layout/AdminPageHeader";
import { ProfileForm, type ProfileFormValues } from "./ProfileForm";

/**
 * Creating a profile is one operation: the repository writes the profile, its
 * Call ID and any media in a single transaction, so a failure halfway through
 * leaves nothing behind.
 */
export function CreateProfilePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("Creating profile…");

  const handleSubmit = async (values: ProfileFormValues) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    const start = performance.now();
    setSubmitting(true);
    setError(null);

    try {
      const profile = await adminRepository.createProfile({
        onProgress: setProgress,
        displayName: values.displayName,
        shortBio: values.shortBio,
        status: values.status,
        baseFollowerCount: values.baseFollowerCount,
        baseLikeCount: values.baseLikeCount,
        avatarFile: values.avatarFile,
        coverFile: values.coverFile,
        remoteVideoFile: values.remoteVideoFile,
        remoteAudioFile: values.remoteAudioFile,
      });
      toast.success("Profile created.");
      // `created` makes the new Call ID the first thing highlighted on arrival.
      navigate(`/admin/profiles/${profile.id}`, { replace: true, state: { created: true } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create this profile.");
      submittingRef.current = false;
      setSubmitting(false);
    } finally {
      productionDiagnostic("PROFILE_CREATE_TIMING", { stage: "total", durationMs: Math.round(performance.now() - start) });
    }
  };

  return (
    <>
      <AdminPageHeader
        title="Create profile"
        description="Create a person who can be reached through CallaStar."
        eyebrow={
          <Link className="admin-link" to="/admin/profiles">
            Profiles
          </Link>
        }
      />

      {error && (
        <p className="admin-error-banner" role="alert">
          {error}
        </p>
      )}

      <ProfileForm
        mode="create"
        submitting={submitting}
        progressLabel={progress}
        submitLabel="Create profile"
        onSubmit={(values) => void handleSubmit(values)}
        onCancel={() => navigate("/admin/profiles")}
      />
    </>
  );
}

export default CreateProfilePage;
