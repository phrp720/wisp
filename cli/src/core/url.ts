/** A URL as a browser will take it. Bare hosts like `app.acme.com` are assumed https. */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("empty url");

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).toString();
  } catch {
    throw new Error(`not a valid url: ${value}`);
  }
}

/**
 * Whether two URLs point at the same page for the purpose of not opening it twice.
 *
 * Trailing slashes and fragments are noise — `acme.com` and `acme.com/` are one page, and
 * so are `#overview` and `#billing` on a dashboard. A query string is not: a filtered Jira
 * view is a different destination from an unfiltered one.
 */
export function sameUrl(left: string, right: string): boolean {
  const normalized = comparable(left);
  return normalized !== undefined && normalized === comparable(right);
}

function comparable(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }

  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
}
