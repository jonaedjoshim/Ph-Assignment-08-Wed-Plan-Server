import { Router, type Request, type Response } from "express";
import mongoose from "mongoose";
import type { AuthInstance } from "../auth.js";
import { requireAuth, requireRole } from "../middleware/auth.middileware.js";

type BookingStatus = "pending" | "accepted" | "rejected" | "cancelled";
type BookingStatusFilter = "all" | BookingStatus;

const bookingStatuses: readonly BookingStatus[] = [
  "pending",
  "accepted",
  "rejected",
  "cancelled",
];

const bookingStatusFilters: readonly BookingStatusFilter[] = [
  "all",
  ...bookingStatuses,
];

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

const serviceFields = [
  "serviceId",
  "service",
  "listingId",
  "vendorServiceId",
  "service.id",
  "service._id",
] as const;

const vendorFields = [
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

const eventDateFields = [
  "eventDate",
  "weddingDate",
  "bookingDate",
  "date",
] as const;

const messageFields = [
  "message",
  "notes",
  "specialRequests",
  "details",
] as const;

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

function getDocumentId(value: Record<string, unknown>): string {
  return getId(value._id) || getId(value.id);
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

function getFirstString(
  record: Record<string, unknown> | undefined,
  fields: readonly string[],
): string | null {
  if (!record) {
    return null;
  }

  for (const field of fields) {
    const value = getString(getFieldValue(record, field));

    if (value) {
      return value;
    }
  }

  return null;
}

function getFirstValue(
  record: Record<string, unknown>,
  fields: readonly string[],
): unknown {
  for (const field of fields) {
    const value = getFieldValue(record, field);

    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return null;
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

function isBookingStatusFilter(value: string): value is BookingStatusFilter {
  return (bookingStatusFilters as readonly string[]).includes(value);
}

function normalizeBookingStatus(value: unknown): BookingStatus | null {
  return typeof value === "string" &&
    (bookingStatuses as readonly string[]).includes(value)
    ? (value as BookingStatus)
    : null;
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

function getServiceImage(
  service: Record<string, unknown> | undefined,
  booking: Record<string, unknown>,
): string | null {
  if (service && Array.isArray(service.images)) {
    for (const image of service.images) {
      const imageValue = isRecord(image) ? image.url : image;
      const safeUrl = toHttpsUrl(imageValue);

      if (safeUrl) {
        return safeUrl;
      }
    }
  }

  return (
    toHttpsUrl(service?.imageUrl ?? service?.image ?? service?.photoUrl) ??
    toHttpsUrl(booking.serviceImage)
  );
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
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
  console.error("Customer booking request failed.", error);

  response.status(500).json({
    success: false,
    message: "Unable to load or update bookings.",
  });
}

export function createCustomerBookingRouter(auth: AuthInstance) {
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

      let statusFilter: BookingStatusFilter = "all";

      if (request.query.status !== undefined) {
        if (
          typeof request.query.status !== "string" ||
          !isBookingStatusFilter(request.query.status)
        ) {
          response.status(400).json({
            success: false,
            message:
              "Status must be all, pending, accepted, rejected, or cancelled.",
          });
          return;
        }

        statusFilter = request.query.status;
      }

      const page = parsePositiveInteger(request.query.page, 1, 100_000);
      const limit = parsePositiveInteger(request.query.limit, 20, 50);

      if (page === null || limit === null) {
        response.status(400).json({
          success: false,
          message: "Page or limit is invalid.",
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

      const bookingsCollection = database.collection("bookings");
      const servicesCollection = database.collection("services");
      const usersCollection = database.collection("user");

      const bookingFilter: Record<string, unknown> = {
        $or: createIdAlternatives(customerFields, customerId),
      };

      if (statusFilter !== "all") {
        bookingFilter.status = statusFilter;
      }

      const [bookingDocuments, total] = await Promise.all([
        bookingsCollection
          .find(bookingFilter as never)
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        bookingsCollection.countDocuments(bookingFilter as never),
      ]);

      const bookingRecords = bookingDocuments
        .map((document) => document as Record<string, unknown>)
        .filter(
          (booking) => getFirstId(booking, customerFields) === customerId,
        );

      const serviceIds = [
        ...new Set(
          bookingRecords
            .map((booking) => getFirstId(booking, serviceFields))
            .filter((id) => id.length > 0),
        ),
      ];

      const serviceAlternatives = serviceIds.flatMap((serviceId) =>
        createIdAlternatives(["_id"], serviceId),
      );

      const serviceDocuments =
        serviceAlternatives.length > 0
          ? await servicesCollection
              .find({ $or: serviceAlternatives } as never)
              .toArray()
          : [];

      const servicesById = new Map<string, Record<string, unknown>>();

      for (const document of serviceDocuments) {
        const service = document as Record<string, unknown>;
        const id = getDocumentId(service);

        if (id) {
          servicesById.set(id, service);
        }
      }

      const vendorIds = [
        ...new Set(
          bookingRecords
            .map((booking) => {
              const serviceId = getFirstId(booking, serviceFields);
              const service = servicesById.get(serviceId);

              return (
                (service ? getFirstId(service, serviceOwnerFields) : "") ||
                getFirstId(booking, vendorFields)
              );
            })
            .filter((id) => id.length > 0),
        ),
      ];

      const vendorAlternatives = vendorIds.flatMap((vendorId) =>
        createIdAlternatives(["id", "_id"], vendorId),
      );

      const vendorDocuments =
        vendorAlternatives.length > 0
          ? await usersCollection
              .find({ $or: vendorAlternatives } as never, {
                projection: {
                  _id: 1,
                  id: 1,
                  name: 1,
                  fullName: 1,
                  businessName: 1,
                  email: 1,
                },
              })
              .toArray()
          : [];

      const vendorsById = new Map<string, Record<string, unknown>>();

      for (const document of vendorDocuments) {
        const vendor = document as Record<string, unknown>;
        const id = getString(vendor.id);
        const databaseId = getId(vendor._id);

        if (id) {
          vendorsById.set(id, vendor);
        }

        if (databaseId) {
          vendorsById.set(databaseId, vendor);
        }
      }

      const bookings = bookingRecords
        .map((booking) => {
          const id = getDocumentId(booking);
          const status = normalizeBookingStatus(booking.status);

          if (!id || !status) {
            return null;
          }

          const serviceId = getFirstId(booking, serviceFields);
          const service = servicesById.get(serviceId);
          const vendorId =
            (service ? getFirstId(service, serviceOwnerFields) : "") ||
            getFirstId(booking, vendorFields);
          const vendor = vendorId ? vendorsById.get(vendorId) : undefined;

          const servicePriceValue =
            service?.price ??
            getFieldValue(booking, "servicePrice") ??
            getFieldValue(booking, "price");

          return {
            id,
            serviceId,
            serviceName:
              getFirstString(service, ["serviceName", "name", "title"]) ??
              getFirstString(booking, [
                "serviceName",
                "serviceTitle",
                "service.name",
              ]) ??
              "Service unavailable",
            serviceCategory:
              getFirstString(service, ["category"]) ??
              getFirstString(booking, ["serviceCategory"]) ??
              "",
            servicePrice: getNumber(servicePriceValue),
            serviceLocation:
              getFirstString(service, ["location"]) ??
              getFirstString(booking, ["serviceLocation"]) ??
              "",
            serviceImage: getServiceImage(service, booking),
            vendor: vendorId
              ? {
                  id: vendorId,
                  name:
                    getFirstString(vendor, ["name", "fullName"]) ??
                    getFirstString(booking, ["vendor.name"]) ??
                    "Vendor",
                  businessName:
                    getFirstString(vendor, ["businessName"]) ??
                    getFirstString(booking, ["vendor.businessName"]) ??
                    "",
                  email:
                    getFirstString(vendor, ["email"]) ??
                    getFirstString(booking, ["vendor.email"]) ??
                    "",
                }
              : null,
            eventDate: toIsoString(getFirstValue(booking, eventDateFields)),
            message: getFirstString(booking, messageFields) ?? "",
            status,
            createdAt: toIsoString(booking.createdAt),
          };
        })
        .filter((booking) => booking !== null);

      response.status(200).json({
        success: true,
        bookings,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  router.patch("/:bookingId/cancel", async (request, response) => {
    try {
      const customerId = await getSessionUserId(auth, request);

      if (!customerId) {
        response.status(401).json({
          success: false,
          message: "Authentication is required.",
        });
        return;
      }

      const bookingId = request.params.bookingId;

      if (!bookingId || bookingId.length > 100) {
        response.status(400).json({
          success: false,
          message: "Booking ID is invalid.",
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

      const bookingsCollection = database.collection("bookings");
      const bookingAlternatives = createIdAlternatives(["_id"], bookingId);

      const document = await bookingsCollection.findOne({
        $or: bookingAlternatives,
      } as never);

      if (!document) {
        response.status(404).json({
          success: false,
          message: "Booking was not found.",
        });
        return;
      }

      const booking = document as Record<string, unknown>;

      if (getFirstId(booking, customerFields) !== customerId) {
        response.status(403).json({
          success: false,
          message: "You cannot cancel this booking.",
        });
        return;
      }

      if (normalizeBookingStatus(booking.status) !== "pending") {
        response.status(409).json({
          success: false,
          message: "Only pending bookings can be cancelled.",
        });
        return;
      }

      const updateResult = await bookingsCollection.updateOne(
        {
          _id: booking._id,
          status: "pending",
          $or: createIdAlternatives(customerFields, customerId),
        } as never,
        {
          $set: {
            status: "cancelled",
            updatedAt: new Date(),
          },
        },
      );

      if (updateResult.modifiedCount !== 1) {
        response.status(409).json({
          success: false,
          message: "The booking changed. Refresh and try again.",
        });
        return;
      }

      response.status(200).json({
        success: true,
        booking: {
          id: bookingId,
          status: "cancelled",
        },
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  return router;
}
