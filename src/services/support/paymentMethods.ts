export const PAYMENT_METHODS = [
  { id: "bank_transfer", label: "Bank Transfer" },
  { id: "cash_app", label: "Cash App" },
  { id: "cryptocurrency", label: "Cryptocurrency" },
  { id: "gift_cards", label: "Gift Cards" },
  { id: "paypal", label: "PayPal" },
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]["id"];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && PAYMENT_METHODS.some((method) => method.id === value);
}

export function paymentMethodLabel(value: PaymentMethod): string {
  return PAYMENT_METHODS.find((method) => method.id === value)?.label ?? "Payment method";
}
