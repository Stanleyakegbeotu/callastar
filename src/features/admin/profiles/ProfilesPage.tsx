import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { matchesFilter, matchesSearch, type ProfileFilter } from "@/services/admin/profileInsights";

import { EmptyState } from "../components/EmptyState";
import { useProfiles } from "../hooks/useAdminData";
import { AdminPageHeader } from "../layout/AdminPageHeader";
import { ProfileAvailabilityCard } from "./ProfileAvailabilityCard";

/**
 * Availability first, because that is what this page is for. The readiness
 * filters stay, but they are about setup rather than about who is online.
 */
const FILTERS: { value: ProfileFilter; label: string; counted: boolean }[] = [
  { value: "all", label: "All", counted: true },
  { value: "active", label: "Active", counted: true },
  { value: "inactive", label: "Inactive", counted: true },
  { value: "ready", label: "Ready", counted: false },
  { value: "missing-video", label: "Missing video", counted: false },
];

/** The main CRM list: search, a short set of filters, and the table. */
export function ProfilesPage() {
  const { data: loaded, loading, error } = useProfiles();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProfileFilter>("all");
  /**
   * Held locally so toggling availability updates the list in place. The value
   * written back is the one the repository returned, so the list never shows a
   * state that was not stored.
   */
  const [profiles, setProfiles] = useState(loaded);
  useEffect(() => setProfiles(loaded), [loaded]);

  // Counts come from the whole list, not the filtered one, so the tabs say
  // how many there are rather than how many are showing.
  const counts = useMemo(
    () => ({
      all: profiles.length,
      active: profiles.filter((profile) => profile.status === "active").length,
      inactive: profiles.filter((profile) => profile.status !== "active").length,
    }),
    [profiles],
  );

  // Profile counts are small locally, so filtering in memory is plenty.
  const visible = useMemo(
    () => profiles.filter((profile) => matchesFilter(profile, filter) && matchesSearch(profile, search)),
    [filter, profiles, search],
  );

  return (
    <>
      <AdminPageHeader
        title="Profiles"
        description="Manage host availability and call readiness."
        actions={
          <Link className="admin-button admin-button-primary" to="/admin/profiles/new">
            New profile
          </Link>
        }
      />

      {error && (
        <p className="admin-error-banner" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="admin-hint">Loading profiles…</p>
      ) : profiles.length === 0 ? (
        <EmptyState
          title="No profiles yet"
          description="Create your first CallaStar profile to generate a Call ID and assign remote call media."
          action={
            <Link className="admin-button admin-button-primary" to="/admin/profiles/new">
              Create profile
            </Link>
          }
        />
      ) : (
        <>
          <div className="admin-toolbar">
            <div className="admin-search">
              <label className="admin-visually-hidden" htmlFor="profile-search">
                Search profiles
              </label>
              <input
                id="profile-search"
                className="admin-input"
                type="search"
                placeholder="Search by name or Call ID"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="admin-filters" role="group" aria-label="Filter profiles">
              {FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`admin-filter ${filter === option.value ? "is-active" : ""}`}
                  aria-pressed={filter === option.value}
                  onClick={() => setFilter(option.value)}
                >
                  {option.label}
                  {option.counted && (
                    <span className="admin-filter-count">
                      {counts[option.value as "all" | "active" | "inactive"]}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <EmptyState title="No matching profiles" description="Try a different search term or filter." />
          ) : (
            <ul className="availability-list">
              {visible.map((profile) => (
                <ProfileAvailabilityCard
                  key={profile.id}
                  profile={profile}
                  onChanged={(updated) =>
                    setProfiles((current) => current.map((item) => (item.id === updated.id ? updated : item)))
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

export default ProfilesPage;
