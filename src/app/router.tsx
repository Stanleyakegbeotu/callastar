import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AdminLoginPage } from "@/features/admin/AdminLoginPage";
import { AdminRoute } from "@/features/admin/AdminRoute";
import { AdminLayout } from "@/features/admin/layout/AdminLayout";
import { MediaPage } from "@/features/admin/media/MediaPage";
import { NotificationsPage } from "@/features/admin/notifications/NotificationsPage";
import { AdminOverviewPage } from "@/features/admin/overview/AdminOverviewPage";
import { CreateProfilePage } from "@/features/admin/profiles/CreateProfilePage";
import { EditProfilePage } from "@/features/admin/profiles/EditProfilePage";
import { ProfileDetailPage } from "@/features/admin/profiles/ProfileDetailPage";
import { ProfilesPage } from "@/features/admin/profiles/ProfilesPage";
import { SessionDetailPage } from "@/features/admin/sessions/SessionDetailPage";
import { CallEvidencePage } from "@/features/admin/sessions/CallEvidencePage";
import { SessionsPage } from "@/features/admin/sessions/SessionsPage";
import { AdminSettingsPage } from "@/features/admin/settings/AdminSettingsPage";
import { EditPlanPage } from "@/features/admin/subscriptions/EditPlanPage";
import { SubscriptionPlansPage } from "@/features/admin/subscriptions/SubscriptionPlansPage";
import { SubscriptionRequestDetailPage } from "@/features/admin/subscriptions/SubscriptionRequestDetailPage";
import { SubscriptionRequestsPage } from "@/features/admin/subscriptions/SubscriptionRequestsPage";
import { SupportInboxPage } from "@/features/admin/support/SupportInboxPage";
import { TransformationStudioPage } from "@/features/transformation/studio/TransformationStudioPage";
import { AdminSupportThreadPage } from "@/features/admin/support/SupportThreadPage";
import { CallTypePage } from "@/features/call-selection/CallTypePage";
import { CallSessionRoute } from "@/features/call-session/CallSessionRoute";
import { JoinCallPage } from "@/features/join-call/JoinCallPage";
import { PlansPage } from "@/features/join-call/PlansPage";
import { OnboardingPage } from "@/features/onboarding/OnboardingPage";
import { WelcomeRewardPage } from "@/features/onboarding/WelcomeRewardPage";
import { SupportIdentifyPage, SupportThreadPage } from "@/features/support/SupportPage";
import { resolveRouterBasename } from "@/lib/utils";

/**
 * Public flow:
 *
 *   /                        landing / onboarding
 *   /connect                 choose the call type
 *   /join/:callType          caller details, Call ID and permission for a call
 *   /call/:sessionId         the call itself, which renders by session status
 *   /plans                   access plans, for a caller whose preview is spent
 *   /support                 customer care: find a conversation by email
 *   /support/:conversationId one customer's support thread
 *
 * The transient call states (permissions, connecting, ringing, active, ended)
 * deliberately share one URL: they are stages of a single call, not places a
 * caller can navigate to or link into. The subscription checkpoint has no URL
 * either, for the same reason, and customer care opened from it is an overlay
 * rather than a navigation — going somewhere would throw away the request the
 * customer is in the middle of.
 *
 * Admin workspace, behind one guard and one layout:
 *
 *   /admin/login                      sign in or set up the first administrator
 *   /admin                            overview
 *   /admin/profiles                   list, create, detail, edit
 *   /admin/sessions                   recorded call sessions and one session
 *   /admin/subscriptions              access requests, and the global plans
 *   /admin/support                    customer care inbox and one conversation
 *   /admin/media                      remote call video and audio per profile
 *   /admin/notifications              what needs attention
 *   /admin/settings                   support and application preferences
 *   /admin/studio                     Transformation Studio (live tracking preview)
 *
 * Session state lives in memory, so reloading a /call URL has nothing to
 * restore and redirects home. A static host serving this app needs the usual
 * SPA fallback so a deep URL is answered with index.html.
 */
export function AppRouter() {
  return (
    <BrowserRouter basename={resolveRouterBasename()}>
      <Routes>
        <Route path="/" element={<OnboardingPage />} />
        <Route path="/welcome-reward" element={<WelcomeRewardPage />} />
        <Route path="/connect" element={<CallTypePage />} />
        <Route path="/join/:callType" element={<JoinCallPage />} />
        <Route path="/call/:sessionId" element={<CallSessionRoute />} />
        <Route path="/plans" element={<PlansPage />} />
        <Route path="/support" element={<SupportIdentifyPage />} />
        <Route path="/support/:conversationId" element={<SupportThreadPage />} />

        <Route path="/admin/login" element={<AdminLoginPage />} />
        <Route
          path="/admin"
          element={
            <AdminRoute>
              <AdminLayout />
            </AdminRoute>
          }
        >
          <Route index element={<AdminOverviewPage />} />
          <Route path="profiles" element={<ProfilesPage />} />
          <Route path="profiles/new" element={<CreateProfilePage />} />
          <Route path="profiles/:profileId" element={<ProfileDetailPage />} />
          <Route path="profiles/:profileId/edit" element={<EditProfilePage />} />
          <Route path="media" element={<MediaPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="sessions/:sessionId" element={<SessionDetailPage />} />
          <Route path="evidence" element={<CallEvidencePage />} />
          <Route path="recordings" element={<Navigate to="/admin/evidence" replace />} />
          {/* Plans before :requestId, or "plans" would be read as an id. */}
          <Route path="subscriptions" element={<SubscriptionRequestsPage />} />
          <Route path="subscriptions/plans" element={<SubscriptionPlansPage />} />
          <Route path="subscriptions/plans/:planId" element={<EditPlanPage />} />
          <Route path="subscriptions/:requestId" element={<SubscriptionRequestDetailPage />} />
          <Route path="support" element={<SupportInboxPage />} />
          <Route path="support/:conversationId" element={<AdminSupportThreadPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="studio" element={<TransformationStudioPage />} />
          <Route path="settings" element={<AdminSettingsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default AppRouter;
