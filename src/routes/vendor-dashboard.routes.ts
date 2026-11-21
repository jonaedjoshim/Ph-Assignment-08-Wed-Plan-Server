import { Router, type Request, type Response } from "express";
import mongoose from "mongoose";
import type { AuthInstance } from "../auth.js";
import { getActivePlan } from "../lib/subscription-plan.js";
import { requireAuth, requireRole } from "../middleware/auth.middileware.js";

type BookingStatus = "pending" | "accepted" | "rejected" | "cancelled";

const serviceOwnerFields = [
  "vendorId",
  "providerId",
  "ownerId",
  "userId",
  "createdBy",
  "vendor",
  "vendor.id",
  "vendor._id",
  "owner",
  "owner.id",
  "owner._id",
  "user.id",
  "user._id",
] as const;

const bookingVendorFields = [
  "vendorId",
  "providerId",
  "sellerId",
  "ownerId",
  "vendor",
  "vendor.id",
  "vendor._id",
  "provider.id",
  "provider._id",
  "owner.id",
  "owner._id",
] as const;

const bookingServiceFields = [
  "serviceId",
  "service",
  "listingId",
  "vendorServiceId",
  "service.id",
  "service._id",
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

function getDocumentId(record: Record<string, unknown>): string {
  return getId(record._id) || getId(record.id);
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

function matchesId(
  record: Record<string, unknown>,
  fields: readonly string[],
  expectedId: string,
): boolean {
  return fields.some(
    (field) => getId(getFieldValue(record, field)) === expectedId,
  );
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

function normalizeBookingStatus(value: unknown): BookingStatus | null {
  return typeof value === "string" &&
    (bookingStatuses as readonly string[]).includes(value)
    ? (value as BookingStatus)
    : null;
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);

    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return null;
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
  console.error("Vendor dashboard request failed.", error);

  response.status(500).json({
    success: false,
    message: "Unable to load vendor dashboard statistics.",
  });
}

export function createVendorDashboardRouter(auth: AuthInstance) {
  const router = Router();

  router.use(requireAuth(auth), requireRole("vendor"));

  router.get("/", async (request, response) => {
    try {
      const vendorId = await getSessionUserId(auth, request);

      if (!vendorId) {
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

      const servicesCollection = database.collection("services");
      const bookingsCollection = database.collection("bookings");
      const usersCollection = database.collection("user");

      const vendorServicesDocuments = await servicesCollection
        .find({
          $or: createIdAlternatives(serviceOwnerFields, vendorId),
        } as never)
        .toArray();

      const vendorServices = vendorServicesDocuments
        .map((document) => document as Record<string, unknown>)
        .filter((service) => matchesId(service, serviceOwnerFields, vendorId));

      const vendorServiceIds = [
        ...new Set(
          vendorServices
            .map((service) => getDocumentId(service))
            .filter((id) => id.length > 0),
        ),
      ];

      const bookingAlternatives = createIdAlternatives(
        bookingVendorFields,
        vendorId,
      );

      for (const serviceId of vendorServiceIds) {
        bookingAlternatives.push(
          ...createIdAlternatives(bookingServiceFields, serviceId),
        );
      }

      const bookingDocuments = await bookingsCollection
        .find({ $or: bookingAlternatives } as never)
        .toArray();

      const bookingRecords = bookingDocuments.map(
        (document) => document as Record<string, unknown>,
      );

      const referencedServiceIds = [
        ...new Set(
          bookingRecords
            .map((booking) => getFirstId(booking, bookingServiceFields))
            .filter((id) => id.length > 0),
        ),
      ];

      const allServiceIds = [
        ...new Set([...vendorServiceIds, ...referencedServiceIds]),
      ];

      const serviceLookupAlternatives = allServiceIds.flatMap((serviceId) =>
        createIdAlternatives(["_id"], serviceId),
      );

      const referencedServiceDocuments =
        serviceLookupAlternatives.length > 0
          ? await servicesCollection
              .find({ $or: serviceLookupAlternatives } as never)
              .toArray()
          : [];

      const servicesById = new Map<string, Record<string, unknown>>();

      for (const document of [
        ...vendorServices,
        ...referencedServiceDocuments.map(
          (item) => item as Record<string, unknown>,
        ),
      ]) {
        const serviceId = getDocumentId(document);

        if (serviceId) {
          servicesById.set(serviceId, document);
        }
      }

      const ownedServiceIds = new Set(vendorServiceIds);

      const ownedBookings = bookingRecords.filter((booking) => {
        const serviceId = getFirstId(booking, bookingServiceFields);
        const bookingMatchesVendor = matchesId(
          booking,
          bookingVendorFields,
          vendorId,
        );

        if (!serviceId) {
          return bookingMatchesVendor;
        }

        if (ownedServiceIds.has(serviceId)) {
          return true;
        }

        const linkedService = servicesById.get(serviceId);

        if (linkedService) {
          return matchesId(linkedService, serviceOwnerFields, vendorId);
        }

        return bookingMatchesVendor;
      });

      const serviceStats = {
        total: vendorServices.length,
        active: vendorServices.filter(
          (service) =>
            service.status === "approved" && service.isActive !== false,
        ).length,
        pending: vendorServices.filter(
          (service) => service.status === "pending",
        ).length,
        approved: vendorServices.filter(
          (service) => service.status === "approved",
        ).length,
        rejected: vendorServices.filter(
          (service) => service.status === "rejected",
        ).length,
      };

      const bookingCounts: Record<BookingStatus, number> = {
        pending: 0,
        accepted: 0,
        rejected: 0,
        cancelled: 0,
      };

      for (const booking of ownedBookings) {
        const status = normalizeBookingStatus(booking.status);

        if (status) {
          bookingCounts[status] += 1;
        }
      }

      const userAlternatives = createIdAlternatives(["id", "_id"], vendorId);

      const userDocument = await usersCollection.findOne(
        { $or: userAlternatives } as never,
        {
          projection: {
            subscriptionPlan: 1,
            subscriptionExpiresAt: 1,
          },
        },
      );

      const user = userDocument
        ? (userDocument as Record<string, unknown>)
        : null;

      response.status(200).json({
        success: true,
        dashboard: {
          services: serviceStats,
          bookings: {
            total: Object.values(bookingCounts).reduce(
              (total, count) => total + count,
              0,
            ),
            ...bookingCounts,
          },
          subscription: {
            plan: getActivePlan(user ?? {}),
            expiresAt: toIsoString(user?.subscriptionExpiresAt),
          },
        },
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  return router;
}
