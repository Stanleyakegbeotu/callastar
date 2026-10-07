import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { SupportChat } from "@/features/support/SupportChat";
import { announcePackageChange } from "@/features/support/supportAutomation";
import { useSupportConversation } from "@/features/support/hooks/useSupportConversation";
import { initI18n } from "@/i18n";
import { supportRepository } from "@/services/support/repository";
import type { SubscriptionPlan } from "@/services/subscriptions/types";
import "@/styles/globals.css";

const plan: Pick<SubscriptionPlan, "id" | "displayName" | "priceMinorUnits" | "currencyCode" | "sortOrder" | "sessionDurationMinutes" | "description" | "features"> = {
  id: "plus",
  displayName: "Plus",
  priceMinorUnits: 3900,
  currencyCode: "USD",
  sortOrder: 1,
  sessionDurationMinutes: 30,
  description: "A focused session with your host.",
  features: ["Stable calls", "Secure conversations", "Free meet-and-greet pass"],
};
const proPlan: typeof plan = {
  id: "pro",
  displayName: "Pro",
  priceMinorUnits: 6900,
  currencyCode: "USD",
  sortOrder: 2,
  sessionDurationMinutes: 60,
  description: "More time with your host.",
  features: ["Longer sessions", "Extended creator access", "Free meet-and-greet pass"],
};

function Fixture() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState(plan);
  const state = useSupportConversation(conversationId, "customer");

  useEffect(() => {
    let cancelled = false;
    void supportRepository.startConversation({
      customerEmail: "sarah@example.com",
      customerName: "Sarah Lee",
      subject: "Plus subscription",
    }).then(async (conversation) => {
      await supportRepository.updateConversation(conversation.id, {
        checkoutDraft: {
          profileId: "host-1",
          profileName: "Amara",
          planId: plan.id,
          planName: plan.displayName,
          description: plan.description,
          features: plan.features,
          priceMinorUnits: plan.priceMinorUnits,
          currencyCode: plan.currencyCode,
          sortOrder: plan.sortOrder,
          sessionDurationMinutes: plan.sessionDurationMinutes,
          channel: "in_app",
          checkoutIntentId: crypto.randomUUID(),
          conversationMode: "payment",
          subscriptionFollowupStatus: "awaiting_decision",
        },
      });
      if (!cancelled) setConversationId(conversation.id);
    });
    return () => { cancelled = true; };
  }, []);

  if (!conversationId) return <p>Opening conversation...</p>;
  if (!open) return <button type="button" onClick={() => setOpen(true)}>Reopen chat</button>;
  return (
    <main className="support-page support-page-chat">
      <SupportChat
        state={state}
        viewer="customer"
        title="CallaStar Support"
        subtitle="Customer care"
        onBack={() => setOpen(false)}
        onPaymentMethodSubmitted={() => undefined}
        onContinueToWhatsapp={() => { window.open("https://wa.me/123", "_blank", "noopener"); }}
        onContinueInApp={() => { window.dispatchEvent(new Event("callastar:continue-in-app")); }}
        packagePlan={selectedPlan}
        packageOptions={[plan, proPlan]}
        onSelectPackage={async (planId) => {
          const selected = planId === proPlan.id ? proPlan : plan;
          const conversation = await supportRepository.getConversation(conversationId);
          if (!conversation?.checkoutDraft) return;
          await supportRepository.updateConversation(conversationId, {
            checkoutDraft: {
              ...conversation.checkoutDraft,
              planId: selected.id,
              planName: selected.displayName,
              priceMinorUnits: selected.priceMinorUnits,
              currencyCode: selected.currencyCode,
              sortOrder: selected.sortOrder,
              sessionDurationMinutes: selected.sessionDurationMinutes,
              description: selected.description,
              features: selected.features,
              subscriptionFollowupStatus: "awaiting_decision",
              paymentDecision: null,
              selectedPaymentMethod: null,
              checkoutIntentId: crypto.randomUUID(),
              conversationMode: "payment",
            },
          });
          await announcePackageChange(conversationId, selected);
          setSelectedPlan(selected);
          state.reload();
        }}
      />
    </main>
  );
}

initI18n();
createRoot(document.getElementById("root")!).render(<Fixture />);
