export class Problem extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}
export interface ProblemDetails {
  type: string;
  status: number;
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, string>;
}
export interface Principal {
  accountId: string;
  personId: string | null;
  mfaEnabled: boolean;
}
