import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { supportRepository } from "@/services/support/repository";
import type { SupportConversation, SupportMessage, SupportMessageView } from "@/services/support/types";

import {
  announcePackageChange,
  answerSubscriptionDecision,
  continuePaymentMethodSelection,
  enterSubscriptionChat,
  markSupportChatExit,
  requestPaymentMethodHelp,
  selectPaymentMethod,
} from "./supportAutomation";
import type { PaymentMethod } from "@/services/support/paymentMethods";

vi.mock("@/services/support/repository", () => ({
  supportRepository: {
    getConversation: vi.fn(),
    listMessages: vi.fn(),
    sendMessage: vi.fn(),
    selectPaymentMethod: vi.fn(),
    updateConversation: vi.fn(),
  },
}));
vi.mock("@/lib/localEvents", () => ({ broadcastLocalEvent: vi.fn() }));

const start = Date.parse("2026-10-06T12:00:00.000Z");
const plus = {
  id: "plus" as const,
  displayName: "Plus",
  priceMinorUnits: 3900,
  currencyCode: "USD",
  features: ["Stable calls", "Secure conversations", "Free meet-and-greet pass"],
};
const pro = {
  id: "pro" as const,
  displayName: "Pro",
  priceMinorUnits: 6900,
  currencyCode: "USD",
  features: ["Longer sessions", "Extended creator access", "Free meet-and-greet pass"],
};

let conversation: SupportConversation;
let messages: SupportMessage[];
let now = start;
const session = new Map<string, string>();
const changed = vi.fn();

async function complete(promise: Promise<unknown>) {
  await vi.runAllTimersAsync();
  await promise;
}

async function enter(plan: typeof plus | typeof pro = plus, at = start) {
  await complete(enterSubscriptionChat(conversation.id, plan, at, changed));
}

function bodies() {
  return messages.map((message) => message.body);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  now = start;
  messages = [];
  session.clear();
  changed.mockReset();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => { session.set(key, value); },
  });
  conversation = {
    id: "thread-1",
    customerEmail: "sarah@example.com",
    customerEmailNormalized: "sarah@example.com",
    customerName: "Sarah Lee",
    subject: "Plus subscription",
    status: "open",
    subscriptionRequestId: null,
    packageBriefSeenAt: null,
    checkoutDraft: {
      profileId: "host-1",
      profileName: "Amara",
      planId: plus.id,
      planName: plus.displayName,
      priceMinorUnits: plus.priceMinorUnits,
      currencyCode: plus.currencyCode,
      sortOrder: 1,
      sessionDurationMinutes: 15,
      channel: "in_app",
      features: plus.features,
      subscriptionFollowupStatus: "awaiting_decision",
    },
    lastMessagePreview: "",
    lastMessageAt: new Date(start).toISOString(),
    lastMessageSender: "customer",
    unreadForAdmin: 0,
    unreadForCustomer: 0,
    createdAt: new Date(start).toISOString(),
    updatedAt: new Date(start).toISOString(),
  };
  vi.mocked(supportRepository.getConversation).mockImplementation(async () => structuredClone(conversation));
  vi.mocked(supportRepository.listMessages).mockImplementation(async (): Promise<SupportMessageView[]> =>
    messages.map((message) => ({ message, asset: null, replyTo: null })),
  );
  vi.mocked(supportRepository.updateConversation).mockImplementation(async (_id, patch) => {
    conversation = { ...conversation, ...patch };
    return structuredClone(conversation);
  });
  vi.mocked(supportRepository.sendMessage).mockImplementation(async (input) => {
    const id = input.idempotencyKey ? `event:${input.conversationId}:${input.idempotencyKey}` : `message:${messages.length}`;
    let message = messages.find((candidate) => candidate.id === id);
    if (!message) {
      message = {
        id,
        conversationId: input.conversationId,
        sender: input.sender,
        body: input.body,
        attachmentId: null,
        replyToMessageId: null,
        createdAt: new Date(now++).toISOString(),
      };
      messages.push(message);
    }
    return { message, asset: null, conversation };
  });
  vi.mocked(supportRepository.selectPaymentMethod).mockImplementation(async ({ conversationId, planId, checkoutIntentId, method }) => {
    if (conversationId !== conversation.id || conversation.checkoutDraft?.planId !== planId) return false;
    const draft = conversation.checkoutDraft;
    if ((draft.checkoutIntentId ?? `${conversationId}:${planId}`) !== checkoutIntentId) return false;
    if (draft.selectedPaymentMethod) return draft.selectedPaymentMethod === method;
    if (draft.paymentDecision !== "yes" || draft.subscriptionFollowupStatus !== "awaiting_payment_method") return false;
    if (messages.some((message) => message.sender === "admin")) return false;
    const bodyByMethod: Record<PaymentMethod, string> = {
      bank_transfer: "Bank Transfer",
      cash_app: "Cash App",
      cryptocurrency: "Cryptocurrency",
      gift_cards: "Gift Cards",
      paypal: "PayPal",
    };
    const id = `event:${conversationId}:payment-method:${checkoutIntentId}`;
    messages.push({
      id,
      conversationId,
      sender: "customer",
      body: bodyByMethod[method],
      action: { type: "select_payment_method", value: method },
      attachmentId: null,
      replyToMessageId: null,
      createdAt: new Date(now++).toISOString(),
    });
    conversation.checkoutDraft = {
      ...draft,
      checkoutIntentId,
      selectedPaymentMethod: method,
      subscriptionFollowupStatus: "payment_method_selected",
    };
    return true;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("subscription chat automation", () => {
  it("saves one first-visit introduction with the selected package and benefits", async () => {
    await enter();
    expect(messages.map((message) => message.sender)).toEqual(["assistant", "assistant", "assistant"]);
    expect(bodies()[0]).toContain("Sarah");
    expect(bodies()[1]).toContain("Plus at $39");
    expect(bodies()[1]).toContain("Free meet-and-greet pass");
    expect(bodies()[2]).toBe("Would you like to continue with your payment?");
    await enter();
    expect(messages).toHaveLength(3);
  });

  it("records Yes and shows the structured payment selection prompt", async () => {
    await enter();
    await complete(answerSubscriptionDecision(conversation.id, plus.id, "yes", changed));
    expect(bodies().slice(-3)).toEqual(["Yes", "Thank you for confirming.", "Please select your preferred payment method below."]);
    expect(conversation.checkoutDraft?.paymentDecision).toBe("yes");
    expect(conversation.checkoutDraft?.subscriptionFollowupStatus).toBe("awaiting_payment_method");
    await complete(answerSubscriptionDecision(conversation.id, plus.id, "yes", changed));
    expect(messages).toHaveLength(6);
  });

  it("records No and leaves the customer in normal support", async () => {
    await enter();
    await complete(answerSubscriptionDecision(conversation.id, plus.id, "no", changed));
    expect(bodies().slice(-2)).toEqual(["No", "Okay, how can we help you today?"]);
    expect(conversation.checkoutDraft?.subscriptionFollowupStatus).toBe("needs_help");
  });

  it.each([
    ["bank_transfer", "Bank Transfer"],
    ["cash_app", "Cash App"],
    ["cryptocurrency", "Cryptocurrency"],
    ["gift_cards", "Gift Cards"],
    ["paypal", "PayPal"],
  ] as const)("accepts %s only as a structured selection", async (method, label) => {
    await enter();
    await complete(answerSubscriptionDecision(conversation.id, plus.id, "yes", changed));
    const intentId = `${conversation.id}:${plus.id}`;
    await complete(selectPaymentMethod(conversation.id, plus.id, intentId, method, changed));
    expect(bodies().slice(-3)).toEqual([label, `Thank you. You've selected ${label}.`, "A CallaStar specialist will confirm the payment details with you here."]);
    expect(messages.at(-3)?.action).toEqual({ type: "select_payment_method", value: method });
    expect(conversation.checkoutDraft?.selectedPaymentMethod).toBe(method);
    expect(conversation.checkoutDraft?.subscriptionFollowupStatus).toBe("awaiting_specialist");
  });

  it("rejects typed text and unsupported actions without advancing payment", async () => {
    await enter();
    await complete(answerSubscriptionDecision(conversation.id, plus.id, "yes", changed));
    const count = messages.length;
    await complete(supportRepository.sendMessage({ conversationId: conversation.id, sender: "customer", body: "hi" }));
    expect(conversation.checkoutDraft?.selectedPaymentMethod).toBeFalsy();
    expect(conversation.checkoutDraft?.subscriptionFollowupStatus).toBe("awaiting_payment_method");
    expect(bodies().at(-1)).toBe("hi");
    expect(bodies()).not.toContain("A CallaStar specialist will confirm the payment details with you here.");
    expect(await selectPaymentMethod(conversation.id, plus.id, `${conversation.id}:${plus.id}`, "hi", changed)).toBe(false);
    expect(messages.length).toBe(count + 1);
    expect(conversation.checkoutDraft?.subscriptionFollowupStatus).toBe("awaiting_payment_method");
  });

  it("creates one payment selection on repeated action delivery", async () => {
    await enter();
    await complete(answerSubscriptionDecision(conversation.id, plus.id, "yes", changed));
    const intentId = `${conversation.id}:${plus.id}`;
    await complete(Promise.all([
      selectPaymentMethod(conversation.id, plus.id, intentId, "bank_transfer", changed),
      selectPaymentMethod(conversation.id, plus.id, intentId, "bank_transfer", changed),
    ]));
    expect(messages.filter((message) => message.body === "Bank Transfer")).toHaveLength(1);
    expect(messages.filter((message) => message.body.includes("specialist will confirm"))).toHaveLength(1);
    expect(await selectPaymentMethod(conversation.id, plus.id, intentId, "paypal", changed)).toBe(false);
  });

  it("rejects a selection tied to a stale package or checkout attempt", async () => {
    await enter();
    await complete(answerSubscriptionDecision(conversation.id, plus.id, "yes", changed));
    const oldIntent = `${conversation.id}:${plus.id}`;
    conversation.checkoutDraft = { ...conversation.checkoutDraft!, planId: pro.id, checkoutIntentId: "new-pro-checkout" };
    expect(await selectPaymentMethod(conversation.id, plus.id, oldIntent, "paypal", changed)).toBe(false);
    expect(conversation.checkoutDraft?.selectedPaymentMethod).toBeFalsy();
    expect(conversation.checkoutDraft?.subscriptionFollowupStatus).toBe("awaiting_payment_method");
  });

  it("stops method selection after an admin takes over", async () => {
    await enter();
    await complete(answerSubscriptionDecision(conversation.id, plus.id, "yes", changed));
    messages.push({ id: "admin-payment", conversationId: conversation.id, sender: "admin", body: "I can help", attachmentId: null, replyToMessageId: null, createdAt: new Date(now++).toISOString() });
    expect(await selectPaymentMethod(conversation.id, plus.id, `${conversation.id}:${plus.id}`, "bank_transfer", changed)).toBe(false);
    expect(conversation.checkoutDraft?.selectedPaymentMethod).toBeFalsy();
    expect(bodies()).not.toContain("A CallaStar specialist will confirm the payment details with you here.");
  });

  it("returns to the selected plan payment after a method was recorded", async () => {
    await enter();
    await complete(answerSubscriptionDecision(conversation.id, plus.id, "yes", changed));
    await complete(selectPaymentMethod(conversation.id, plus.id, `${conversation.id}:${plus.id}`, "bank_transfer", changed));
    markSupportChatExit(conversation.id);
    await enter(plus, start + 2000);
    expect(bodies().at(-1)).toContain("Bank Transfer payment");
  });

  it("welcomes a returning customer after Yes with continuation actions", async () => {
    await enter();
    await complete(answerSubscriptionDecision(conversation.id, plus.id, "yes", changed));
    markSupportChatExit(conversation.id);
    await enter(plus, start + 2000);
    expect(bodies().at(-1)).toContain("continue choosing your payment method");
    expect(messages.filter((message) => message.id.endsWith(":intro-welcome"))).toHaveLength(1);
  });

  it("continues payment only through the return action and preserves unfinished state on help", async () => {
    await enter();
    await complete(answerSubscriptionDecision(conversation.id, plus.id, "yes", changed));
    markSupportChatExit(conversation.id);
    await enter(plus, start + 2000);
    const intentId = `${conversation.id}:${plus.id}`;
    const visit = conversation.checkoutDraft?.lastAutomatedVisitKey ?? "return";
    await complete(continuePaymentMethodSelection(conversation.id, plus.id, intentId, visit, changed));
    expect(bodies().at(-1)).toBe("Please select your preferred payment method below.");
    await complete(requestPaymentMethodHelp(conversation.id, plus.id, intentId, visit, changed));
    expect(bodies().at(-1)).toBe("Okay, how can we help you today?");
    expect(conversation.checkoutDraft?.subscriptionFollowupStatus).toBe("awaiting_payment_method");
    expect(conversation.checkoutDraft?.conversationMode).toBe("support");
  });

  it("welcomes a returning customer after No with a help-focused message", async () => {
    await enter();
    await complete(answerSubscriptionDecision(conversation.id, plus.id, "no", changed));
    markSupportChatExit(conversation.id);
    await enter(plus, start + 2000);
    expect(bodies().at(-1)).toBe("Welcome back, Sarah. How can we help you today?");
  });

  it("recognizes a new device session from persisted conversation state", async () => {
    await enter();
    session.clear();
    await enter(plus, start + 2000);
    expect(bodies().at(-1)).toContain("Welcome back, Sarah");
    expect(messages.filter((message) => message.id.endsWith(":intro-welcome"))).toHaveLength(1);
  });

  it("keeps the original question when the customer returns without answering", async () => {
    await enter();
    markSupportChatExit(conversation.id);
    await enter(plus, start + 2000);
    expect(bodies().at(-1)).toContain("continue where you left off");
    expect(messages.filter((message) => message.id.endsWith(":intro-question"))).toHaveLength(1);
    expect(conversation.checkoutDraft?.subscriptionFollowupStatus).toBe("awaiting_decision");
  });

  it("does not duplicate messages on concurrent StrictMode-style entries or reconnect", async () => {
    await complete(Promise.all([
      enterSubscriptionChat(conversation.id, plus, start, changed),
      enterSubscriptionChat(conversation.id, plus, start, changed),
    ]));
    await enter();
    expect(messages).toHaveLength(3);
  });

  it("stops proactive replies after an admin takes over", async () => {
    await enter();
    messages.push({ id: "admin-1", conversationId: conversation.id, sender: "admin", body: "I can help", attachmentId: null, replyToMessageId: null, createdAt: new Date(now++).toISOString() });
    markSupportChatExit(conversation.id);
    await enter(plus, start + 2000);
    expect(messages).toHaveLength(4);
    expect(await answerSubscriptionDecision(conversation.id, plus.id, "yes", changed)).toBe(false);
  });

  it("stops a staged introduction if an admin replies before the first bubble", async () => {
    const entering = enterSubscriptionChat(conversation.id, plus, start, changed);
    messages.push({ id: "admin-early", conversationId: conversation.id, sender: "admin", body: "I can help", attachmentId: null, replyToMessageId: null, createdAt: new Date(now++).toISOString() });
    await complete(entering);
    expect(messages).toHaveLength(1);
  });

  it("uses a natural return greeting when the customer name is blank", async () => {
    conversation.customerName = "";
    await enter();
    markSupportChatExit(conversation.id);
    await enter(plus, start + 2000);
    expect(bodies().at(-1)).toBe("Welcome back. Would you like to continue where you left off?");
  });

  it("uses Pro data when Pro is selected and preserves history on a package change", async () => {
    await enter();
    conversation.checkoutDraft = { ...conversation.checkoutDraft!, planId: pro.id, planName: pro.displayName, priceMinorUnits: pro.priceMinorUnits, currencyCode: pro.currencyCode, features: pro.features };
    await announcePackageChange(conversation.id, pro);
    expect(bodies().at(-1)).toContain("Pro at $69");
    expect(messages.filter((message) => message.id.endsWith(":intro-welcome"))).toHaveLength(1);
    expect(messages[1]?.body).toContain("Plus at $39");
  });

  it("uses the selected Pro data in a fresh conversation", async () => {
    conversation.checkoutDraft = { ...conversation.checkoutDraft!, planId: pro.id, planName: pro.displayName, priceMinorUnits: pro.priceMinorUnits, currencyCode: pro.currencyCode, features: pro.features };
    await enter(pro);
    expect(bodies()[1]).toContain("Pro at $69");
    expect(bodies()[1]).toContain("Extended creator access");
    expect(bodies()[1]).not.toContain("Stable calls");
  });
});
