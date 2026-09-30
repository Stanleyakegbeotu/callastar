import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { adminRepository } from "@/services/admin/repository";

import { useToast } from "../components/ToastProvider";
import { useProfile } from "../hooks/useAdminData";
import { AdminPageHeader } from "../layout/AdminPageHeader";
import { ProfileForm, type ProfileFormValues } from "./ProfileForm";

/**
 * Editing covers identity and the avatar. The remote call video is managed from
 * its own card on the detail page, where replacement is a deliberate,
 * confirmed action rather than a side effect of saving a form.
 */
export function EditProfilePage() {
  const { profileId } = useParams<{ profileId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: profile, loading, error } = useProfile(profileId);
  const [submitting, setSubmitting] = useState(false);

  if (loading) return <p className="admin-hint">Loading profile…</p>;
  if (error) return <p className="admin-error-banner" role="alert">{error}</p>;
  if (!profile) {
    return (
      <>
        <AdminPageHeader title="Profile not found" description="This profile no longer exists." />
        <Link className="admin-button admin-button-primary" to="/admin/profiles">Back to profiles</Link>
      </>
    );
  }

  const handleSubmit = async (values: ProfileFormValues) => {
    setSubmitting(true);
    try {
      await adminRepository.updateProfile(profile.id, {
        displayName: values.displayName,
        shortBio: values.shortBio,
        status: values.status,
      });

      // Media changes are separate writes so a failed upload cannot silently
      // discard the text edits that already saved.
      if (values.avatarFile) {
        await adminRepository.setAvatar(profile.id, values.avatarFile);
        toast.success("Avatar updated.");
      } else if (values.removeAvatar) {
        await adminRepository.removeAvatar(profile.id);
        toast.success("Avatar removed.");
      }

      toast.success("Profile updated.");
      navigate(`/admin/profiles/${profile.id}`);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not save this profile.");
      setSubmitting(false);
    }
  };

  return (
    <>
      <AdminPageHeader
        title="Edit profile"
        description="Update how this person appears in CallaStar."
        eyebrow={<Link className="admin-link" to={`/admin/profiles/${profile.id}`}>{profile.displayName}</Link>}
      />

      <ProfileForm
        mode="edit"
        initialName={profile.displayName}
        initialBio={profile.shortBio}
        initialStatus={profile.status}
        avatarAssetId={profile.avatarAssetId}
        submitting={submitting}
        submitLabel="Save changes"
        onSubmit={(values) => void handleSubmit(values)}
        onCancel={() => navigate(`/admin/profiles/${profile.id}`)}
      />
    </>
  );
}

export default EditProfilePage;
