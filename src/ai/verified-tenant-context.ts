export type VerifiedTenantContext = Readonly<{
  businessId: number;
  channel: string;
  providerAccountId: string;
  verified: true;
}>;

/**
 * Consumes a tenant identity already authenticated and resolved by a trusted
 * channel adapter. This function does not authenticate webhook requests.
 *
 * Never construct VerifiedTenantContext from customer-provided identifiers
 * or an unverified global configuration.
 */
export function timingTenantFromVerifiedContext(
  context: VerifiedTenantContext | null | undefined,
  channel: string,
  providerAccountId: string,
): number | null {
  if (!context || context.verified !== true) return null;
  if (context.channel !== channel) return null;
  if (!providerAccountId || context.providerAccountId !== providerAccountId) return null;

  const id = context.businessId;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
