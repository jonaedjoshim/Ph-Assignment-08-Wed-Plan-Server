import "dotenv/config";

function readPort(value: string | undefined): number {
  const port = Number(value ?? 5000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return port;
}

const mongodbUri = process.env.MONGODB_URI?.trim();
const clientUrl = process.env.CLIENT_URL?.trim();
const betterAuthUrl = process.env.BETTER_AUTH_URL?.trim();
const betterAuthSecret = process.env.BETTER_AUTH_SECRET?.trim();
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() || undefined;
const googleClientSecret =
  process.env.GOOGLE_CLIENT_SECRET?.trim() || undefined;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim() || undefined;
const stripeWebhookSecret =
  process.env.STRIPE_WEBHOOK_SECRET?.trim() || undefined;
const stripePremiumPriceId =
  process.env.STRIPE_PREMIUM_PRICE_ID?.trim() || undefined;
const stripeStarterPriceId =
  process.env.STRIPE_STARTER_PRICE_ID?.trim() || undefined;

if (!mongodbUri) {
  throw new Error("MONGODB_URI is required.");
}

if (!clientUrl) {
  throw new Error("CLIENT_URL is required.");
}

if (!betterAuthUrl) {
  throw new Error("BETTER_AUTH_URL is required.");
}

if (!betterAuthSecret || betterAuthSecret.length < 32) {
  throw new Error("BETTER_AUTH_SECRET must be at least 32 characters.");
}

if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
  throw new Error(
    "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be configured.",
  );
}

export const env = {
  port: readPort(process.env.PORT),
  clientUrl,
  mongodbUri,
  betterAuthUrl,
  betterAuthSecret,
  googleClientId,
  googleClientSecret,
  stripeSecretKey,
  stripeWebhookSecret,
  stripePremiumPriceId,
  stripeStarterPriceId,
};
