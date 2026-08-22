/**
 * "Open in <tool>": the deep link back to the tool a run came from (12_SPIDERFOOT.md §5.6).
 *
 * Tool knowledge stays out of the core (`apps/web/src/app`, R1) — this module lives in the
 * integration surface and asks the tool's own package for the URL, so adding a tool adds a line
 * here and nothing anywhere else. An unconfigured or implausible instance yields `undefined`, and
 * the surface simply shows no link rather than a broken one.
 */

import { spiderFootBaseUrl, spiderFootScanUrl } from '@nexus/integrations/spiderfoot/manifest';

export function externalRunUrl(
  integrationId: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  if (integrationId !== 'spiderfoot') return undefined;
  const scanId = input.scanId;
  if (typeof scanId !== 'string') return undefined;
  const configured = (import.meta.env as Record<string, string | undefined>)
    .VITE_SPIDERFOOT_BASE_URL;
  return spiderFootScanUrl(scanId, spiderFootBaseUrl({ SPIDERFOOT_BASE_URL: configured }));
}
