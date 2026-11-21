export type SubscriptionPlan = "free" | "starter" | "premium";
export type PaidPlan = Exclude<SubscriptionPlan, "free">;

export const PAID_PLANS: readonly PaidPlan[] = ["starter", "premium"];

export const PLAN_SERVICE_LIMITS: Record<SubscriptionPlan, number | null> = {
  free: 3,
  starter: 10,
  premium: null,
};

export const PLAN_LABELS: Record<SubscriptionPlan, string> = {
  free: "Free",
  starter: "Starter",
  premium: "Premium",
};

export function isSubscriptionPlan(value: unknown): value is SubscriptionPlan {
  return value === "free" || value === "starter" || value === "premium";
}

export function isPaidPlan(value: unknown): value is PaidPlan {
  return value === "starter" || value === "premium";
}

export function getActivePlan(user: Record<string, unknown>): SubscriptionPlan {
  const plan = user.subscriptionPlan;

  if (!isPaidPlan(plan)) {
    return "free";
  }

  const expiresAt = user.subscriptionExpiresAt;

  if (expiresAt === undefined || expiresAt === null) {
    return plan;
  }

  const expiryTime =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : typeof expiresAt === "string"
        ? Date.parse(expiresAt)
        : typeof expiresAt === "number"
          ? expiresAt
          : Number.NaN;

  return Number.isFinite(expiryTime) && expiryTime > Date.now() ? plan : "free";
}

export function getServiceLimit(plan: SubscriptionPlan): number | null {
  return PLAN_SERVICE_LIMITS[plan];
}
