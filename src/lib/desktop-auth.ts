type DesktopEnvironment = Record<string, string | undefined>;

export function isDesktopMode(environment: DesktopEnvironment = process.env): boolean {
  return environment.CPE_DESKTOP_MODE === 'true' && environment.HOSTNAME === '127.0.0.1';
}

export function isLocalDesktopRequest(
  requestHeaders: Pick<Headers, 'get'>,
  environment: DesktopEnvironment = process.env,
): boolean {
  if (!isDesktopMode(environment)) return false;
  const port = environment.PORT || '3210';
  const host = requestHeaders.get('host')?.toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (requestHeaders.get('sec-fetch-site') === 'cross-site') return false;
  const origin = requestHeaders.get('origin');
  return !origin || origin === `http://${host}`;
}
