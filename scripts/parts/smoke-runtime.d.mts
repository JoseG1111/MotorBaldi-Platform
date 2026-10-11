export function runSmoke(options?: {
  cookie?: string;
  anonymous?: boolean;
  automation?: boolean;
  verifyOnly?: boolean;
  fetch?: {
    bivarianceHack(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response>;
  }["bivarianceHack"];
  log?: (message: string) => void;
}): Promise<void>;
export function formatSmokeFailure(error: unknown): string;
