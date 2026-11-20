import express, { Router } from "express";
import mongoose from "mongoose";
import Stripe from "stripe";
import type { AuthInstance } from "../auth.js";
import { env } from "../config/env.js";
import {
  getAuthenticatedUser,
  requireAuth,
  requireRole,
} from "../middleware/auth.middileware.js";
import { Transaction } from "../models/tracsaction.model.js";

type TransactionStatus = "paid" | "failed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const result = value.trim();
  return result.length > 0 ? result : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getExpandableId(value: unknown): string | null {
  const directId = getString(value);

  if (directId) {
    return directId;
  }

  if (isRecord(value)) {
    return getString(value.id);
  }

  return null;
}

function getUserCollection() {
  const database = mongoose.connection.db;
  return database ? database.collection("user") : null;
}

function createUserIdFilter(userId: string) {
  const alternatives: Record<string, unknown>[] = [
    { id: userId },
    { _id: userId },
  ];

  if (/^[a-fA-F0-9]{24}$/.test(userId)) {
    alternatives.push({
      _id: new mongoose.Types.ObjectId(userId),
    });
  }

  return { $or: alternatives };
}

function getUserDocumentId(user: Record<string, unknown>): string | null {
  const id = getString(user.id);

  if (id) {
    return id;
  }

  if (typeof user._id === "string") {
    return user._id;
  }

  if (user._id instanceof mongoose.Types.ObjectId) {
    return user._id.toHexString();
  }

  return null;
}

function toDateFromUnixSeconds(value: unknown): Date | null {
  const seconds = getNumber(value);

  if (seconds === null || seconds <= 0) {
    return null;
  }

  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getSubscriptionExpiry(subscription: Stripe.Subscription): Date | null {
  const subscriptionRecord = subscription as unknown as Record<string, unknown>;
  const directExpiry = toDateFromUnixSeconds(
    subscriptionRecord.current_period_end,
  );

  if (directExpiry) {
    return directExpiry;
  }

  const items = subscriptionRecord.items;

  if (!isRecord(items) || !Array.isArray(items.data)) {
    return null;
  }

  for (const item of items.data) {
    if (isRecord(item)) {
      const itemExpiry = toDateFromUnixSeconds(item.current_period_end);

      if (itemExpiry) {
        return itemExpiry;
      }
    }
  }

  return null;
}

async function findUserIdBySubscriptionId(
  subscriptionId: string,
): Promise<string | null> {
  const users = getUserCollection();

  if (!users) {
    throw new Error("Database connection is unavailable.");
  }

  const user = await users.findOne(
    { stripeSubscriptionId: subscriptionId },
    {
      projection: {
        _id: 1,
        id: 1,
      },
    },
  );

  return user
    ? getUserDocumentId(user as unknown as Record<string, unknown>)
    : null;
}

async function resolveSubscriptionUserId(
  subscription: Stripe.Subscription,
): Promise<string | null> {
  const metadataUserId = getString(subscription.metadata.userId);

  if (metadataUserId) {
    return metadataUserId;
  }

  return findUserIdBySubscriptionId(subscription.id);
}

async function syncSubscriptionUser(
  subscription: Stripe.Subscription,
  userIdOverride?: string,
  allowReplace = false,
): Promise<string | null> {
  const userId =
    userIdOverride ?? (await resolveSubscriptionUserId(subscription));

  if (!userId) {
    return null;
  }

  const users = getUserCollection();

  if (!users) {
    throw new Error("Database connection is unavailable.");
  }

  const filter = createUserIdFilter(userId);
  const existingUser = await users.findOne(filter, {
    projection: {
      stripeSubscriptionId: 1,
    },
  });

  if (!existingUser) {
    return null;
  }

  const existingSubscriptionId = getString(
    (existingUser as Record<string, unknown>).stripeSubscriptionId,
  );

  if (
    existingSubscriptionId &&
    existingSubscriptionId !== subscription.id &&
    !allowReplace
  ) {
    return userId;
  }

  const expiry = getSubscriptionExpiry(subscription);
  const isActive =
    (subscription.status === "active" || subscription.status === "trialing") &&
    expiry !== null &&
    expiry.getTime() > Date.now();

  const update: Record<string, unknown> = {
    subscriptionPlan: isActive ? "premium" : "free",
    subscriptionExpiresAt: isActive ? expiry : null,
    subscriptionCancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: getExpandableId(subscription.customer),
    updatedAt: new Date(),
  };

  const result = await users.updateOne(filter, {
    $set: update,
  });

  return result.matchedCount > 0 ? userId : null;
}

function isStoredPremiumActive(user: Record<string, unknown>): boolean {
  if (user.subscriptionPlan !== "premium") {
    return false;
  }

  const expiresAt = user.subscriptionExpiresAt;

  if (expiresAt === undefined || expiresAt === null) {
    return true;
  }

  const expiryTime =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : typeof expiresAt === "string"
        ? Date.parse(expiresAt)
        : typeof expiresAt === "number"
          ? expiresAt
          : Number.NaN;

  return Number.isFinite(expiryTime) && expiryTime > Date.now();
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const invoiceRecord = invoice as unknown as Record<string, unknown>;
  const directId = getExpandableId(invoiceRecord.subscription);

  if (directId) {
    return directId;
  }

  const parent = invoiceRecord.parent;

  if (!isRecord(parent) || !isRecord(parent.subscription_details)) {
    return null;
  }

  return getExpandableId(parent.subscription_details.subscription);
}

async function handleCheckoutSession(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (session.mode !== "subscription" || session.metadata?.plan !== "premium") {
    return;
  }

  const subscriptionId = getExpandableId(session.subscription);

  if (!subscriptionId) {
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const userId =
    getString(session.client_reference_id) ??
    getString(session.metadata?.userId) ??
    getString(subscription.metadata.userId);

  if (!userId) {
    return;
  }

  await syncSubscriptionUser(subscription, userId, true);
}

async function handleSubscriptionEvent(
  subscription: Stripe.Subscription,
): Promise<void> {
  if (subscription.metadata.plan !== "premium") {
    return;
  }

  await syncSubscriptionUser(subscription);
}

async function handleInvoiceEvent(
  stripe: Stripe,
  invoice: Stripe.Invoice,
  status: TransactionStatus,
): Promise<void> {
  const invoiceRecord = invoice as unknown as Record<string, unknown>;
  const invoiceId = getString(invoiceRecord.id);
  const subscriptionId = getInvoiceSubscriptionId(invoice);

  if (!invoiceId || !subscriptionId) {
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  if (subscription.metadata.plan !== "premium") {
    return;
  }

  const userId = await resolveSubscriptionUserId(subscription);

  if (!userId) {
    return;
  }

  const syncedUserId = await syncSubscriptionUser(subscription, userId);

  if (!syncedUserId) {
    return;
  }

  const amount =
    status === "paid"
      ? (getNumber(invoiceRecord.amount_paid) ?? 0)
      : (getNumber(invoiceRecord.amount_due) ??
        getNumber(invoiceRecord.amount_remaining) ??
        0);

  const currency = getString(invoiceRecord.currency)?.toLowerCase() ?? "usd";

  await Transaction.findOneAndUpdate(
    { stripeInvoiceId: invoiceId },
    {
      $set: {
        userId,
        stripeInvoiceId: invoiceId,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId:
          getExpandableId(invoiceRecord.customer) ??
          getExpandableId(subscription.customer),
        amount,
        currency,
        status,
        plan: "premium",
        invoiceNumber: getString(invoiceRecord.number),
        hostedInvoiceUrl: getString(invoiceRecord.hosted_invoice_url),
        paidAt: status === "paid" ? new Date() : null,
      },
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );
}

async function handleStripeEvent(
  stripe: Stripe,
  event: Stripe.Event,
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await handleCheckoutSession(
        stripe,
        event.data.object as Stripe.Checkout.Session,
      );
      return;

    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await handleSubscriptionEvent(event.data.object as Stripe.Subscription);
      return;

    case "invoice.paid":
      await handleInvoiceEvent(
        stripe,
        event.data.object as Stripe.Invoice,
        "paid",
      );
      return;

    case "invoice.payment_failed":
      await handleInvoiceEvent(
        stripe,
        event.data.object as Stripe.Invoice,
        "failed",
      );
      return;
  }
}

export function createStripeRouter(auth: AuthInstance) {
  const router = Router();
  const stripe = env.stripeSecretKey ? new Stripe(env.stripeSecretKey) : null;

  router.post(
    "/webhook",
    express.raw({
      type: "application/json",
      limit: "1mb",
    }),
    async (req, res) => {
      const webhookSecret = env.stripeWebhookSecret;

      if (!stripe || !webhookSecret) {
        res.status(503).json({
          success: false,
          message: "Stripe webhook is not configured.",
        });
        return;
      }

      const signature = req.get("stripe-signature");

      if (!signature || !Buffer.isBuffer(req.body)) {
        res.status(400).json({
          success: false,
          message: "A valid Stripe webhook signature is required.",
        });
        return;
      }

      let event: Stripe.Event;

      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          signature,
          webhookSecret,
        );
      } catch {
        res.status(400).json({
          success: false,
          message: "Stripe webhook signature verification failed.",
        });
        return;
      }

      try {
        await handleStripeEvent(stripe, event);
        res.status(200).json({ received: true });
      } catch (error) {
        console.error("Stripe webhook processing failed.", error);
        res.status(500).json({
          success: false,
          message: "Stripe webhook processing failed.",
        });
      }
    },
  );

  router.post(
    "/checkout",
    requireAuth(auth),
    requireRole("vendor"),
    async (_req, res) => {
      const user = getAuthenticatedUser(res);
      const premiumPriceId = env.stripePremiumPriceId;

      if (!user) {
        res.status(401).json({
          success: false,
          message: "Authentication is required.",
        });
        return;
      }

      if (!stripe || !premiumPriceId) {
        res.status(503).json({
          success: false,
          message: "Stripe Premium checkout is not configured.",
        });
        return;
      }

      const users = getUserCollection();

      if (!users) {
        res.status(500).json({
          success: false,
          message: "Database connection is unavailable.",
        });
        return;
      }

      try {
        const profile = await users.findOne(createUserIdFilter(user.id), {
          projection: {
            isBlocked: 1,
            subscriptionPlan: 1,
            subscriptionExpiresAt: 1,
            stripeCustomerId: 1,
          },
        });

        if (!profile) {
          res.status(404).json({
            success: false,
            message: "Account not found.",
          });
          return;
        }

        const account = profile as unknown as Record<string, unknown>;

        if (account.isBlocked === true) {
          res.status(403).json({
            success: false,
            message: "This account has been blocked.",
          });
          return;
        }

        if (isStoredPremiumActive(account)) {
          res.status(409).json({
            success: false,
            message: "This account already has an active Premium plan.",
          });
          return;
        }

        const price = await stripe.prices.retrieve(premiumPriceId);

        if (!price.active || !price.recurring) {
          res.status(503).json({
            success: false,
            message:
              "The configured Stripe Price must be an active recurring price.",
          });
          return;
        }

        const stripeCustomerId = getString(account.stripeCustomerId);
        const clientBaseUrl = env.clientUrl.replace(/\/+$/, "");

        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          line_items: [{ price: premiumPriceId, quantity: 1 }],
          success_url: `${clientBaseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${clientBaseUrl}/payment/cancel`,
          client_reference_id: user.id,
          metadata: {
            plan: "premium",
            userId: user.id,
          },
          subscription_data: {
            metadata: {
              plan: "premium",
              userId: user.id,
            },
          },
          ...(stripeCustomerId
            ? { customer: stripeCustomerId }
            : { customer_email: user.email }),
        });

        if (!session.url) {
          res.status(502).json({
            success: false,
            message: "Stripe did not return a checkout URL.",
          });
          return;
        }

        res.status(200).json({
          success: true,
          url: session.url,
        });
      } catch (error) {
        console.error("Stripe checkout creation failed.", error);
        res.status(502).json({
          success: false,
          message: "Unable to create a Stripe checkout session.",
        });
      }
    },
  );

  router.post(
    "/cancel",
    requireAuth(auth),
    requireRole("vendor"),
    async (_req, res) => {
      const user = getAuthenticatedUser(res);

      if (!user) {
        res.status(401).json({
          success: false,
          message: "Authentication is required.",
        });
        return;
      }

      if (!stripe) {
        res.status(503).json({
          success: false,
          message: "Stripe subscription management is not configured.",
        });
        return;
      }

      const users = getUserCollection();

      if (!users) {
        res.status(500).json({
          success: false,
          message: "Database connection is unavailable.",
        });
        return;
      }

      try {
        const filter = createUserIdFilter(user.id);
        const profile = await users.findOne(filter, {
          projection: {
            stripeSubscriptionId: 1,
          },
        });

        if (!profile) {
          res.status(404).json({
            success: false,
            message: "Account not found.",
          });
          return;
        }

        const subscriptionId = getString(
          (profile as Record<string, unknown>).stripeSubscriptionId,
        );

        if (!subscriptionId) {
          res.status(404).json({
            success: false,
            message: "No Premium subscription was found.",
          });
          return;
        }

        const subscription =
          await stripe.subscriptions.retrieve(subscriptionId);

        const canCancel =
          subscription.status === "active" ||
          subscription.status === "trialing" ||
          subscription.status === "past_due" ||
          subscription.status === "unpaid";

        if (!canCancel) {
          res.status(409).json({
            success: false,
            message: "This subscription cannot be cancelled.",
          });
          return;
        }

        const updatedSubscription = subscription.cancel_at_period_end
          ? subscription
          : await stripe.subscriptions.update(subscriptionId, {
              cancel_at_period_end: true,
            });

        const expiry = getSubscriptionExpiry(updatedSubscription);
        const update: Record<string, unknown> = {
          subscriptionCancelAtPeriodEnd: true,
          updatedAt: new Date(),
        };

        if (expiry) {
          update.subscriptionExpiresAt = expiry;
        }

        await users.updateOne(filter, {
          $set: update,
        });

        res.status(200).json({
          success: true,
          subscriptionCancelAtPeriodEnd: true,
          subscriptionExpiresAt: expiry?.toISOString() ?? null,
          message:
            "Premium will remain active until the current billing period ends.",
        });
      } catch (error) {
        console.error("Stripe subscription cancellation failed.", error);
        res.status(502).json({
          success: false,
          message: "Unable to cancel the Premium subscription.",
        });
      }
    },
  );

  return router;
}
