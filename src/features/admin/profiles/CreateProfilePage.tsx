import { useState } from "react";
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
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (values: ProfileFormValues) => {
    setSubmitting(true);
    setError(null);

    try {
      const profile = await adminRepository.createProfile({
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
      setSubmitting(false);
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
        submitLabel="Create profile"
        onSubmit={(values) => void handleSubmit(values)}
        onCancel={() => navigate("/admin/profiles")}
      />
    </>
  );
}

export default CreateProfilePage;
