import { images } from "@/assets/images";
import type { HostPreview } from "@/types/host";
import type { CallerDetails } from "@/types/user";

/**
 * Demo data for the explicit mock backend (VITE_CALL_BACKEND=mock), which is
 * only for offline UI work. In local and Supabase modes the host comes from a
 * real profile, so nothing here is used.
 */
export const DEMO_CALL_ID = "CALLA-4829";

export const MOCK_HOST: HostPreview = {
  id: "host_demo_1",
  displayName: "Maya Chen",
  shortName: "Maya",
  avatarUrl: images.host,
  remoteVideoRef: null,
};

/** Caller details the Join Call form starts with while `prefillDemoForm` is on. */
export const DEMO_CALLER: CallerDetails = {
  fullName: "Jordan Lee",
  phone: "+1 (415) 555-0142",
  email: "jordan@example.com",
};

export const EMPTY_CALLER: CallerDetails = {
  fullName: "",
  phone: "",
  email: "",
};
