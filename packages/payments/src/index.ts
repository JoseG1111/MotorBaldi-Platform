export interface PaymentRequest {
  idempotencyKey: string;
  requestId: string;
  amountMinor: bigint;
  currency: string;
  paymentMethodReference: string;
  subjectReference: string;
  signal: AbortSignal;
}
export interface PaymentResult {
  providerReference: string;
  status: "PENDING" | "APPROVED" | "DECLINED" | "UNKNOWN";
}
export interface PaymentProvider {
  charge(input: PaymentRequest): Promise<PaymentResult>;
  reconcile(reference: string, signal: AbortSignal): Promise<PaymentResult>;
}
