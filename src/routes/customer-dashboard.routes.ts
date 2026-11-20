import { Router, type Request, type Response } from "express";
import mongoose from "mongoose";
import type { AuthInstance } from "../auth.js";
import { requireAuth, requireRole } from "../middleware/auth.middileware.js";

type BookingStatus = "pending" | "accepted" | "rejected" | "cancelled";

const customerFields = [
  "customerId",
  "clientId",
  "requesterId",
  "bookedBy",
  "userId",
  "customer",
  "customer.id",
  "customer._id",
  "user.id",
  "user._id",
] as const;

const bookingStatuses: readonly BookingStatus[] = [
  "pending",
  "accepted",
  "rejected",
  "cancelled",
];

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

function getId(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (value instanceof mongoose.Types.ObjectId) {
    return value.toHexString();
  }

  if (isRecord(value)) {
    return getId(value.id) || getId(value._id);
  }

  return "";
}

function getFieldValue(
  record: Record<string, unknown>,
  field: string,
): unknown {
  let value: unknown = record;

  for (const part of field.split(".")) {
    if (!isRecord(value)) {
      return undefined;
    }

    value = value[part];
  }

  return value;
}

function getFirstId(
  record: Record<string, unknown>,
  fields: readonly string[],
): string {
  for (const field of fields) {
    const id = getId(getFieldValue(record, field));

    if (id) {
      return id;
    }
  }

  return "";
}

function createIdAlternatives(
  fields: readonly string[],
  id: string,
): Record<string, unknown>[] {
  const alternatives: Record<string, unknown>[] = [];

  for (const field of fields) {
    alternatives.push({ [field]: id });

    if (/^[a-fA-F0-9]{24}$/.test(id)) {
      alternatives.push({
        [field]: new mongoose.Types.ObjectId(id),
      });
    }
  }

  return alternatives;
}

function isBookingStatus(value: unknown): value is BookingStatus {
  return (
    typeof value === "string" &&
    (bookingStatuses as readonly string[]).includes(value)
  );
}

function createRequestHeaders(request: Request): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      headers.set(name, value.join(", "));
    }
  }

  return headers;
}

async function getSessionUserId(
  auth: AuthInstance,
  request: Request,
): Promise<string | null> {
  const session = await auth.api.getSession({
    headers: createRequestHeaders(request),
  });

  return getString(session?.user?.id);
}

function sendDatabaseError(response: Response, error: unknown): void {
  console.error("Customer dashboard request failed.", error);

  response.status(500).json({
    success: false,
    message: "Unable to load customer dashboard statistics.",
  });
}

export function createCustomerDashboardRouter(auth: AuthInstance) {
  const router = Router();

  router.use(requireAuth(auth), requireRole("customer"));

  router.get("/", async (request, response) => {
    try {
      const customerId = await getSessionUserId(auth, request);

      if (!customerId) {
        response.status(401).json({
          success: false,
          message: "Authentication is required.",
        });
        return;
      }

      const database = mongoose.connection.db;

      if (!database) {
        response.status(500).json({
          success: false,
          message: "Database connection is unavailable.",
        });
        return;
      }

      const bookings = await database
        .collection("bookings")
        .find(
          {
            $or: createIdAlternatives(customerFields, customerId),
          } as never,
          {
            projection: {
              status: 1,
              customerId: 1,
              clientId: 1,
              requesterId: 1,
              bookedBy: 1,
              userId: 1,
              customer: 1,
              user: 1,
            },
          },
        )
        .toArray();

      const counts: Record<BookingStatus, number> = {
        pending: 0,
        accepted: 0,
        rejected: 0,
        cancelled: 0,
      };

      for (const document of bookings) {
        const booking = document as Record<string, unknown>;

        if (getFirstId(booking, customerFields) !== customerId) {
          continue;
        }

        if (isBookingStatus(booking.status)) {
          counts[booking.status] += 1;
        }
      }

      const total = Object.values(counts).reduce(
        (sum, count) => sum + count,
        0,
      );

      response.status(200).json({
        success: true,
        dashboard: {
          bookings: {
            total,
            ...counts,
          },
        },
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  return router;
}
