import { supportRepository } from "@/services/support/repository";
import { broadcastLocalEvent } from "@/lib/localEvents";
import type { SupportCheckoutDraft, SupportConversation } from "@/services/support/types";
import type { SubscriptionPlan } from "@/services/subscriptions/types";
import { formatMinorUnits } from "@/services/subscriptions/money";
import { isPaymentMethod, paymentMethodLabel, type PaymentMethod } from "@/services/support/paymentMethods";

type PlanSnapshot = Pick<SubscriptionPlan, "id" | "displayName" | "priceMinorUnits" | "currencyCode" | "features">;

const RETURN_INTERVAL_MS = 10 * 60 * 1000;
const entries = new Map<string, Promise<void>>();

function exitStorageKey(conversationId: string): string {
  return `callastar-support-exit:${conversationId}`;
}

const SESSION_KEY = "callastar-support-session";

export function markSupportChatExit(conversationId: string): void {
  try {
    sessionStorage.setItem(exitStorageKey(conversationId), crypto.randomUUID());
  } catch {
    // A blocked session store falls back to the inactivity rule.
  }
}

function visitKey(conversationId: string, enteredAt: number): string {
  try {
    const exit = sessionStorage.getItem(exitStorageKey(conversationId));
    if (exit) return `exit:${exit}`;
    let session = sessionStorage.getItem(SESSION_KEY);
    if (!session) {
      session = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, session);
    }
    return `session:${session}:${Math.floor(enteredAt / RETURN_INTERVAL_MS)}`;
  } catch {
    // The time bucket still prevents repeat messages.
  }
  return `time:${Math.floor(enteredAt / RETURN_INTERVAL_MS)}`;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

function price(amountMinorUnits: number, currencyCode: string): string {
  return formatMinorUnits(amountMinorUnits, currencyCode);
}

function eventId(conversationId: string, key: string): string {
  return `event:${conversationId}:${key}`;
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

async function liveConversation(id: string): Promise<SupportConversation | null> {
  const conversation = await supportRepository.getConversation(id);
  if (!conversation) return null;
  const messages = await supportRepository.listMessages(id);
  return messages.some(({ message }) => message.sender === "admin") ? null : conversation;
}

async function automatedMessage(id: string, key: string, body: string, onMessage: () => void): Promise<boolean> {
  if (!await liveConversation(id)) return false;
  await supportRepository.sendMessage({ conversationId: id, sender: "assistant", body, idempotencyKey: key });
  broadcastLocalEvent("support-message", { conversationId: id });
  onMessage();
  return true;
}

async function updateDraft(id: string, change: (draft: SupportCheckoutDraft) => SupportCheckoutDraft): Promise<void> {
  const current = await supportRepository.getConversation(id);
  if (!current?.checkoutDraft) return;
  await supportRepository.updateConversation(id, { checkoutDraft: change(current.checkoutDraft) });
}

async function enterOnce(
  conversationId: string,
  plan: PlanSnapshot,
  enteredAt: number,
  onMessage: () => void,
): Promise<void> {
  const conversation = await liveConversation(conversationId);
  if (!conversation?.checkoutDraft || conversation.checkoutDraft.planId !== plan.id) return;
  const messages = await supportRepository.listMessages(conversationId);
  const hasIntro = messages.some(({ message }) => message.id === eventId(conversationId, "intro-welcome"));
  const hasQuestion = messages.some(({ message }) => message.id === eventId(conversationId, "intro-question"));
  const legacyIntro = Boolean(conversation.packageBriefSeenAt && !hasIntro);
  const visit = visitKey(conversationId, enteredAt);
  const name = firstName(conversation.customerName);

  if (!hasIntro && !legacyIntro) {
    await pause(350);
    if (!await automatedMessage(conversationId, "intro-welcome", name
      ? `Hi ${name}, welcome to CallaStar Support.`
      : "Hi, welcome to CallaStar Support.", onMessage)) return;
  }

  if (!legacyIntro && !hasQuestion) {
    const currentMessages = await supportRepository.listMessages(conversationId);
    if (!currentMessages.some(({ message }) => message.id === eventId(conversationId, "intro-plan"))) await pause(550);
    if ((await supportRepository.getConversation(conversationId))?.checkoutDraft?.planId !== plan.id) return;
    const benefits = plan.features.slice(0, 3).map((feature) => `• ${feature}`).join("\n");
    if (!await automatedMessage(
      conversationId,
      "intro-plan",
      `You've selected ${plan.displayName} at ${price(plan.priceMinorUnits, plan.currencyCode)}.${benefits ? `\n\nYour plan includes:\n${benefits}` : ""}`,
      onMessage,
    )) return;
    const latest = await supportRepository.listMessages(conversationId);
    if (!latest.some(({ message }) => message.id === eventId(conversationId, "intro-question"))) await pause(450);
    if ((await supportRepository.getConversation(conversationId))?.checkoutDraft?.planId !== plan.id) return;
    if (!await automatedMessage(conversationId, "intro-question", "Would you like to continue with your payment?", onMessage)) return;
    const updated = await supportRepository.getConversation(conversationId);
    if (updated && !updated.packageBriefSeenAt) {
      const timestamp = new Date(enteredAt).toISOString();
      await supportRepository.updateConversation(conversationId, { packageBriefSeenAt: timestamp });
      await updateDraft(conversationId, (draft) => ({
        ...draft,
        subscriptionFollowupStatus: draft.subscriptionFollowupStatus ?? "awaiting_decision",
        lastAutomatedReturnVisitAt: timestamp,
        lastAutomatedVisitKey: visit,
      }));
    }
    onMessage();
    return;
  }

  if (hasQuestion && !conversation.packageBriefSeenAt) {
    const timestamp = new Date(enteredAt).toISOString();
    await supportRepository.updateConversation(conversationId, { packageBriefSeenAt: timestamp });
    await updateDraft(conversationId, (draft) => ({ ...draft, lastAutomatedReturnVisitAt: timestamp, lastAutomatedVisitKey: visit }));
    return;
  }

  const lastVisit = conversation.checkoutDraft.lastAutomatedReturnVisitAt ?? conversation.packageBriefSeenAt;
  if (conversation.checkoutDraft.lastAutomatedVisitKey === visit) return;
  if (visit.startsWith("time:") && lastVisit && enteredAt - new Date(lastVisit).getTime() < RETURN_INTERVAL_MS) return;
  const draft = conversation.checkoutDraft;
  const greeting = name ? `Welcome back, ${name}.` : "Welcome back.";
  const selectedPaymentMethod = isPaymentMethod(draft.selectedPaymentMethod) ? draft.selectedPaymentMethod : null;
  const question = draft.paymentDecision === "no" || draft.subscriptionFollowupStatus === "needs_help"
    ? "How can we help you today?"
      : selectedPaymentMethod
        ? `A CallaStar specialist will continue assisting you with your ${paymentMethodLabel(selectedPaymentMethod)} payment here.`
        : draft.paymentDecision === "yes" || draft.subscriptionFollowupStatus === "awaiting_payment_method"
          ? "Would you like to continue choosing your payment method?"
          : "Would you like to continue where you left off?";
  if (!await automatedMessage(conversationId, `return:${visit}`, `${greeting} ${question}`, onMessage)) return;
  await updateDraft(conversationId, (current) => ({
    ...current,
    lastAutomatedReturnVisitAt: new Date(enteredAt).toISOString(),
    lastAutomatedVisitKey: visit,
  }));
  onMessage();
}

/** One entry per meaningful visit. Stable message ids also protect cross-tab retries. */
export function enterSubscriptionChat(
  conversationId: string,
  plan: PlanSnapshot,
  enteredAt: number,
  onMessage: () => void,
): Promise<void> {
  const key = `${conversationId}:${visitKey(conversationId, enteredAt)}`;
  const running = entries.get(key);
  if (running) return running;
  const pending = enterOnce(conversationId, plan, enteredAt, onMessage).finally(() => entries.delete(key));
  entries.set(key, pending);
  return pending;
}

export async function answerSubscriptionDecision(
  conversationId: string,
  planId: string,
  choice: "yes" | "no",
  onMessage: () => void,
): Promise<boolean> {
  const conversation = await liveConversation(conversationId);
  if (!conversation?.checkoutDraft || conversation.checkoutDraft.planId !== planId) return false;
  if (conversation.checkoutDraft.paymentDecision) return false;
  const sent = await supportRepository.sendMessage({
    conversationId,
    sender: "customer",
    body: choice === "yes" ? "Yes" : "No",
    idempotencyKey: `payment-decision:${planId}`,
  });
  broadcastLocalEvent("support-message", { conversationId });
  const recordedChoice = sent.message.body === "Yes" ? "yes" : "no";
  await updateDraft(conversationId, (draft) => ({
    ...draft,
    paymentDecision: recordedChoice,
    subscriptionFollowupStatus: recordedChoice === "yes" ? "awaiting_payment_method" : "needs_help",
    conversationMode: recordedChoice === "yes" ? "payment" : "support",
  }));
  onMessage();
  await pause(450);
  if (recordedChoice === "no") {
    await automatedMessage(conversationId, `payment-reply:${planId}`, "Okay, how can we help you today?", onMessage);
    return recordedChoice === choice;
  }
  const current = await supportRepository.getConversation(conversationId);
  const intentId = current?.checkoutDraft?.checkoutIntentId ?? `${conversationId}:${planId}`;
  if (!await automatedMessage(conversationId, `payment-confirmed:${intentId}`, "Thank you for confirming.", onMessage)) return false;
  await pause(300);
  await automatedMessage(conversationId, `payment-method-prompt:${intentId}:initial`, "Please select your preferred payment method below.", onMessage);
  return recordedChoice === choice;
}

export async function continuePaymentMethodSelection(
  conversationId: string,
  planId: string,
  checkoutIntentId: string,
  visit: string,
  onMessage: () => void,
): Promise<boolean> {
  const conversation = await liveConversation(conversationId);
  if (!conversation?.checkoutDraft || conversation.checkoutDraft.planId !== planId) return false;
  const draft = conversation.checkoutDraft;
  if (draft.subscriptionFollowupStatus !== "awaiting_payment_method" || draft.selectedPaymentMethod) return false;
  if ((draft.checkoutIntentId ?? `${conversationId}:${planId}`) !== checkoutIntentId) return false;
  const sent = await supportRepository.sendMessage({
    conversationId,
    sender: "customer",
    body: "Continue Payment",
    action: { type: "continue_payment_method_selection" },
    idempotencyKey: `continue-payment:${checkoutIntentId}:${visit}`,
  });
  broadcastLocalEvent("support-message", { conversationId });
  await updateDraft(conversationId, (current) => ({ ...current, conversationMode: "payment" }));
  onMessage();
  await pause(250);
  await automatedMessage(conversationId, `payment-method-prompt:${checkoutIntentId}:${visit}`, "Please select your preferred payment method below.", onMessage);
  return true;
}

export async function requestPaymentMethodHelp(
  conversationId: string,
  planId: string,
  checkoutIntentId: string,
  visit: string,
  onMessage: () => void,
): Promise<boolean> {
  const conversation = await liveConversation(conversationId);
  const draft = conversation?.checkoutDraft;
  if (!draft || draft.planId !== planId || draft.subscriptionFollowupStatus !== "awaiting_payment_method" || draft.selectedPaymentMethod) return false;
  if ((draft.checkoutIntentId ?? `${conversationId}:${planId}`) !== checkoutIntentId) return false;
  const sent = await supportRepository.sendMessage({
    conversationId,
    sender: "customer",
    body: "I Need Help",
    action: { type: "payment_method_help" },
    idempotencyKey: `payment-help:${checkoutIntentId}:${visit}`,
  });
  broadcastLocalEvent("support-message", { conversationId });
  await updateDraft(conversationId, (current) => ({ ...current, conversationMode: "support" }));
  onMessage();
  await pause(250);
  await automatedMessage(conversationId, `payment-help-reply:${checkoutIntentId}:${visit}`, "Okay, how can we help you today?", onMessage);
  return true;
}

export async function selectPaymentMethod(
  conversationId: string,
  planId: string,
  checkoutIntentId: string,
  method: unknown,
  onMessage: () => void,
): Promise<boolean> {
  if (!isPaymentMethod(method)) return false;
  const accepted = await supportRepository.selectPaymentMethod({ conversationId, planId, checkoutIntentId, method });
  if (!accepted) return false;
  broadcastLocalEvent("support-message", { conversationId });
  onMessage();
  await pause(250);
  const label = paymentMethodLabel(method as PaymentMethod);
  if (!await automatedMessage(
    conversationId,
    `payment-method-selected:${checkoutIntentId}`,
    `Thank you. You've selected ${label}.`,
    onMessage,
  )) return true;
  await pause(250);
  await automatedMessage(
    conversationId,
    `payment-method-specialist:${checkoutIntentId}`,
    "A CallaStar specialist will confirm the payment details with you here.",
    onMessage,
  );
  const latest = await supportRepository.getConversation(conversationId);
  if (latest?.checkoutDraft?.checkoutIntentId === checkoutIntentId && latest.checkoutDraft.selectedPaymentMethod === method) {
    await updateDraft(conversationId, (draft) => ({ ...draft, subscriptionFollowupStatus: "awaiting_specialist" }));
  }
  return true;
}

export async function announcePackageChange(conversationId: string, plan: PlanSnapshot): Promise<void> {
  await automatedMessage(conversationId, `package-change:${plan.id}`, `You've changed your selection to ${plan.displayName} at ${price(plan.priceMinorUnits, plan.currencyCode)}. You can review the updated benefits in the package header.`, () => undefined);
}
