export interface AdminAccessProfile {
  role?: string | null;
  is_active?: boolean | null;
}

export function hasActiveAdminAccess(profile: AdminAccessProfile | null | undefined): boolean {
  return profile?.role === "admin" && profile.is_active === true;
}
