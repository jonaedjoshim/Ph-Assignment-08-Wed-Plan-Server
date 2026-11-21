import { Router, type Response } from "express";
import mongoose from "mongoose";
import type { AccountRole, AuthInstance } from "../auth.js";
import { isPaidPlan, type PaidPlan } from "../lib/subscription-plan.js";
import { requireAuth, requireRole } from "../middleware/auth.middileware.js";

type TransactionStatus = "pending" | "paid" | "failed" | "expired";
type TransactionStatusFilter = "all" | TransactionStatus;

type TransactionUser = {
  id: string;
  name: string;
  email: string;
  businessName: string;
  role: AccountRole | "unknown";
};

const transactionStatuses: readonly TransactionStatus[] = [
  "pending",
  "paid",
  "failed",
  "expired",
];

const transactionStatusFilters = [
  "all",
  "pending",
  "paid",
  "failed",
  "expired",
] as const;

function isTransactionStatusFilter(
  value: string,
): value is TransactionStatusFilter {
  return (transactionStatusFilters as readonly string[]).includes(value);
}

function toTransactionStatus(value: unknown): TransactionStatus {
  if (
    typeof value === "string" &&
    (transactionStatuses as readonly string[]).includes(value)
  ) {
    return value as TransactionStatus;
  }

  return "pending";
}

function toPaidPlan(value: unknown): PaidPlan {
  return isPaidPlan(value) ? value : "premium";
}

function isAccountRole(value: unknown): value is AccountRole {
  return value === "customer" || value === "vendor" || value === "admin";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number | null {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    return null;
  }

  return parsed;
}

function getDatabaseId(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof mongoose.Types.ObjectId) {
    return value.toHexString();
  }

  return "";
}

function getUserId(user: Record<string, unknown>): string {
  const id = getString(user.id);

  if (id) {
    return id;
  }

  return getDatabaseId(user._id);
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    const date = new Date(value);

    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return null;
}

function toHttpsUrl(value: unknown): string | null {
  const stringValue = getString(value);

  if (!stringValue) {
    return null;
  }

  try {
    const url = new URL(stringValue);

    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function createUserIdAlternatives(userIds: string[]) {
  const alternatives: Record<string, unknown>[] = [];

  for (const userId of userIds) {
    alternatives.push({ id: userId }, { _id: userId });

    if (/^[a-fA-F0-9]{24}$/.test(userId)) {
      alternatives.push({
        _id: new mongoose.Types.ObjectId(userId),
      });
    }
  }

  return alternatives;
}

function toTransactionUser(
  value: Record<string, unknown>,
): TransactionUser | null {
  const id = getUserId(value);

  if (!id) {
    return null;
  }

  return {
    id,
    name: typeof value.name === "string" ? value.name : "",
    email: typeof value.email === "string" ? value.email : "",
    businessName:
      typeof value.businessName === "string" ? value.businessName : "",
    role: isAccountRole(value.role) ? value.role : "unknown",
  };
}

function sendDatabaseError(response: Response, error: unknown): void {
  console.error("Admin transaction request failed.", error);

  response.status(500).json({
    success: false,
    message: "Unable to load transactions.",
  });
}

export function createAdminTransactionRouter(auth: AuthInstance) {
  const router = Router();

  router.use(requireAuth(auth), requireRole("admin"));

  router.get("/", async (req, res) => {
    let statusFilter: TransactionStatusFilter = "all";

    if (req.query.status !== undefined) {
      if (
        typeof req.query.status !== "string" ||
        !isTransactionStatusFilter(req.query.status)
      ) {
        res.status(400).json({
          success: false,
          message: "Status must be all, pending, paid, failed, or expired.",
        });
        return;
      }

      statusFilter = req.query.status;
    }

    let search = "";

    if (req.query.search !== undefined) {
      if (typeof req.query.search !== "string") {
        res.status(400).json({
          success: false,
          message: "Search must be a single query value.",
        });
        return;
      }

      search = req.query.search.trim();

      if (search.length > 100) {
        res.status(400).json({
          success: false,
          message: "Search cannot exceed 100 characters.",
        });
        return;
      }
    }

    const page = parsePositiveInteger(req.query.page, 1, 100_000);
    const limit = parsePositiveInteger(req.query.limit, 20, 50);

    if (page === null || limit === null) {
      res.status(400).json({
        success: false,
        message: "Page or limit is invalid.",
      });
      return;
    }

    const database = mongoose.connection.db;

    if (!database) {
      res.status(500).json({
        success: false,
        message: "Database connection is unavailable.",
      });
      return;
    }

    const transactions = database.collection("transactions");
    const users = database.collection("user");
    const filter: Record<string, unknown> = {};

    if (statusFilter !== "all") {
      filter.status = statusFilter;
    }

    if (search) {
      const pattern = new RegExp(escapeRegex(search), "i");

      filter.$or = [
        { vendorId: pattern },
        { stripeSessionId: pattern },
        { stripeInvoiceId: pattern },
        { stripeSubscriptionId: pattern },
        { stripeCustomerId: pattern },
        { invoiceNumber: pattern },
      ];
    }

    try {
      const [documents, total] = await Promise.all([
        transactions
          .find(filter as never, {
            projection: {
              _id: 1,
              vendorId: 1,
              stripeSessionId: 1,
              stripeInvoiceId: 1,
              stripeSubscriptionId: 1,
              stripeCustomerId: 1,
              amount: 1,
              currency: 1,
              status: 1,
              plan: 1,
              invoiceNumber: 1,
              hostedInvoiceUrl: 1,
              paidAt: 1,
              createdAt: 1,
            },
          })
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        transactions.countDocuments(filter as never),
      ]);

      const records = documents.map(
        (document) => document as Record<string, unknown>,
      );

      const vendorIds = [
        ...new Set(
          records
            .map((record) => getString(record.vendorId))
            .filter((vendorId): vendorId is string => vendorId !== null),
        ),
      ];

      const userAlternatives = createUserIdAlternatives(vendorIds);

      const userDocuments =
        userAlternatives.length > 0
          ? await users
              .find({ $or: userAlternatives } as never, {
                projection: {
                  _id: 1,
                  id: 1,
                  name: 1,
                  email: 1,
                  businessName: 1,
                  role: 1,
                },
              })
              .toArray()
          : [];

      const usersById = new Map<string, TransactionUser>();

      for (const userDocument of userDocuments) {
        const user = toTransactionUser(userDocument as Record<string, unknown>);

        if (user) {
          usersById.set(user.id, user);
        }
      }

      const transactionList = records
        .map((record) => {
          const vendorId = getString(record.vendorId) ?? "";
          const amount = record.amount;

          return {
            id: getDatabaseId(record._id),
            userId: vendorId,
            vendorId,
            user: usersById.get(vendorId) ?? null,
            stripeSessionId: getString(record.stripeSessionId) ?? "",
            stripeInvoiceId: getString(record.stripeInvoiceId) ?? "",
            stripeSubscriptionId: getString(record.stripeSubscriptionId) ?? "",
            stripeCustomerId: getString(record.stripeCustomerId),
            amountMinorUnits:
              typeof amount === "number" &&
              Number.isSafeInteger(amount) &&
              amount >= 0
                ? amount
                : 0,
            currency: getString(record.currency)?.toLowerCase() ?? "usd",
            status: toTransactionStatus(record.status),
            plan: toPaidPlan(record.plan),
            invoiceNumber: getString(record.invoiceNumber),
            hostedInvoiceUrl: toHttpsUrl(record.hostedInvoiceUrl),
            paidAt: toIsoString(record.paidAt),
            createdAt: toIsoString(record.createdAt),
          };
        })
        .filter((transaction) => transaction.id.length > 0);

      res.status(200).json({
        success: true,
        transactions: transactionList,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  return router;
}
