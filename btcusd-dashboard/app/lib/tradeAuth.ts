/** Same-origin check shared by browser-facing trading control routes. */
export function isTrustedTradingOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;

  const configuredOrigin = process.env.TRADING_ALLOWED_ORIGIN;
  if (configuredOrigin) return origin === configuredOrigin;

  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
