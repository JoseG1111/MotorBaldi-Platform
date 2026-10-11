export function runSmoke(options?: {
  anonymous?: boolean;
  fetch?: {
    bivarianceHack(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response>;
  }["bivarianceHack"];
  log?: (message: string) => void;
}): Promise<void>;
export function formatSmokeFailure(error: unknown): string;
