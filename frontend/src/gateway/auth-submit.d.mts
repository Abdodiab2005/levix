export type GatewaySubmitResult =
  | { redirect: string; error?: never }
  | { error: { code: string; message?: string }; retryAfter?: number; redirect?: never };

export function submitGatewayForm(
  url: string,
  form: HTMLFormElement,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<GatewaySubmitResult>;
export function authDestination(
  currentHref: string,
  redirect: string,
  storedHash?: string,
): { href: string; reload: boolean };
export function navigateAfterAuth(redirect: string, win?: Window): void;
