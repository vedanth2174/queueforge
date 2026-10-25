
export type LeaseRenewal = () => Promise<boolean>;

export type HeartbeatOutcome =
  | { status: "renewed" }
  | { status: "lease-lost" }
  | { status: "uncertain"; error: unknown };

export async function renewLeaseSafely(
  renew: LeaseRenewal,
): Promise<HeartbeatOutcome> {
  try {
    const renewed = await renew();

    return renewed
      ? { status: "renewed" }
      : { status: "lease-lost" };
  } catch (error: unknown) {
    return { status: "uncertain", error };
  }
}
