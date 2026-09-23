export interface DeliveryRequest {
  id: string;
  requestId: string;
  recipient: string;
  template: string;
  variables: Readonly<Record<string, string>>;
  signal: AbortSignal;
}
export interface DeliveryReceipt {
  providerReference: string;
  status: "ACCEPTED" | "REJECTED";
}
export interface EmailTransport {
  send(request: DeliveryRequest): Promise<DeliveryReceipt>;
}
export interface MessageTransport {
  send(
    channel: "SMS" | "WHATSAPP",
    request: DeliveryRequest,
  ): Promise<DeliveryReceipt>;
}
