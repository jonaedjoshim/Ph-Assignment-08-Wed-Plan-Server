import { Router, type Request, type Response } from "express";
import mongoose from "mongoose";
import type { AuthInstance } from "../auth.js";
import { requireAuth, requireRole } from "../middleware/auth.middileware.js";

type BookingStatus = "pending" | "accepted" | "rejected" | "cancelled";
type BookingStatusFilter = "all" | BookingStatus;
type BookingDecision = "accepted" | "rejected";

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

const bookingCustomerFields = [
  "customerId",
  "clientId",
  "requesterId",
  "bookedBy",
  "userId",
] as const;

const bookingEventDateFields = [
  "eventDate",
  "weddingDate",
  "bookingDate",
  "date",
] as const;

const bookingMessageFields = [
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
): string | null {
  if (!service) {
    return null;
  }

  if (Array.isArray(service.images)) {
    for (const image of service.images) {
      const imageUrl = isRecord(image) ? image.url : image;
      const safeUrl = toHttpsUrl(imageUrl);

      if (safeUrl) {
        return safeUrl;
      }
    }
  }

  return toHttpsUrl(service.imageUrl ?? service.image ?? service.photoUrl);
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
  console.error("Vendor booking request failed.", error);

  response.status(500).json({
    success: false,
    message: "Unable to load or update bookings.",
  });
}

export function createVendorBookingRouter(auth: AuthInstance) {
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

      const serviceOwnerAlternatives = createIdAlternatives(
        serviceOwnerFields,
        vendorId,
      );

      const vendorServiceDocuments = await servicesCollection
        .find({ $or: serviceOwnerAlternatives } as never)
        .toArray();

      const vendorServiceIds = [
        ...new Set(
          vendorServiceDocuments
            .map((document) =>
              getDocumentId(document as Record<string, unknown>),
            )
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

      const bookingFilter: Record<string, unknown> = {
        $or: bookingAlternatives,
      };

      if (statusFilter !== "all") {
        bookingFilter.status = statusFilter;
      }

      const bookingDocuments = await bookingsCollection
        .find(bookingFilter as never)
        .sort({ createdAt: -1, _id: -1 })
        .toArray();

      const bookingRecords = bookingDocuments.map(
        (document) => document as Record<string, unknown>,
      );

      const referencedServiceIds = bookingRecords
        .map((booking) => getFirstId(booking, bookingServiceFields))
        .filter((id) => id.length > 0);

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
        ...vendorServiceDocuments,
        ...referencedServiceDocuments,
      ]) {
        const service = document as Record<string, unknown>;
        const serviceId = getDocumentId(service);

        if (serviceId) {
          servicesById.set(serviceId, service);
        }
      }

      const ownedBookings = bookingRecords.filter((booking) => {
        const status = normalizeBookingStatus(booking.status);

        if (!status) {
          return false;
        }

        const serviceId = getFirstId(booking, bookingServiceFields);
        const service = servicesById.get(serviceId);
        const serviceOwnerId = service
          ? getFirstId(service, serviceOwnerFields)
          : "";
        const bookingOwnerId = getFirstId(booking, bookingVendorFields);
        const verifiedOwnerId = serviceOwnerId || bookingOwnerId;

        return verifiedOwnerId === vendorId;
      });

      const total = ownedBookings.length;
      const start = (page - 1) * limit;
      const pageBookings = ownedBookings.slice(start, start + limit);

      const customerIds = [
        ...new Set(
          pageBookings
            .map((booking) => getFirstId(booking, bookingCustomerFields))
            .filter((id) => id.length > 0),
        ),
      ];

      const customerAlternatives = customerIds.flatMap((customerId) =>
        createIdAlternatives(["id", "_id"], customerId),
      );

      const customerDocuments =
        customerAlternatives.length > 0
          ? await usersCollection
              .find({ $or: customerAlternatives } as never, {
                projection: {
                  _id: 1,
                  id: 1,
                  name: 1,
                  fullName: 1,
                  email: 1,
                },
              })
              .toArray()
          : [];

      const customersById = new Map<string, Record<string, unknown>>();

      for (const document of customerDocuments) {
        const customer = document as Record<string, unknown>;
        const customerId = getDocumentId(customer);
        const databaseId = getId(customer._id);

        if (customerId) {
          customersById.set(customerId, customer);
        }

        if (databaseId) {
          customersById.set(databaseId, customer);
        }
      }

      const bookings = pageBookings
        .map((booking) => {
          const id = getDocumentId(booking);

          if (!id) {
            return null;
          }

          const serviceId = getFirstId(booking, bookingServiceFields);
          const service = servicesById.get(serviceId);
          const customerId = getFirstId(booking, bookingCustomerFields);
          const customerRecord = customerId
            ? customersById.get(customerId)
            : undefined;
          const status = normalizeBookingStatus(booking.status);

          if (!status) {
            return null;
          }

          return {
            id,
            serviceId,
            serviceName:
              getFirstString(service, ["serviceName", "name", "title"]) ??
              "Service unavailable",
            serviceCategory: getFirstString(service, ["category"]) ?? "",
            serviceImage: getServiceImage(service),
            customer: customerId
              ? {
                  id:
                    (customerRecord ? getDocumentId(customerRecord) : "") ||
                    customerId,
                  name:
                    getFirstString(customerRecord, ["name", "fullName"]) ??
                    "Customer",
                  email: getFirstString(customerRecord, ["email"]) ?? "",
                }
              : null,
            eventDate: toIsoString(
              bookingEventDateFields
                .map((field) => getFieldValue(booking, field))
                .find((value) => value !== undefined),
            ),
            message: getFirstString(booking, bookingMessageFields) ?? "",
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

  router.patch("/:bookingId", async (request, response) => {
    try {
      const vendorId = await getSessionUserId(auth, request);

      if (!vendorId) {
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

      if (!isRecord(request.body)) {
        response.status(400).json({
          success: false,
          message: "A booking decision is required.",
        });
        return;
      }

      const decision = request.body.status;

      if (decision !== "accepted" && decision !== "rejected") {
        response.status(400).json({
          success: false,
          message: "A booking can only be accepted or rejected.",
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

      const bookingAlternatives = createIdAlternatives(["_id"], bookingId);

      const bookingDocument = await bookingsCollection.findOne({
        $or: bookingAlternatives,
      } as never);

      if (!bookingDocument) {
        response.status(404).json({
          success: false,
          message: "Booking was not found.",
        });
        return;
      }

      const booking = bookingDocument as Record<string, unknown>;
      const serviceId = getFirstId(booking, bookingServiceFields);
      const serviceAlternatives = serviceId
        ? createIdAlternatives(["_id"], serviceId)
        : [];

      const serviceDocument =
        serviceAlternatives.length > 0
          ? await servicesCollection.findOne({
              $or: serviceAlternatives,
            } as never)
          : null;

      const service = serviceDocument
        ? (serviceDocument as Record<string, unknown>)
        : undefined;

      const serviceOwnerId = service
        ? getFirstId(service, serviceOwnerFields)
        : "";
      const bookingOwnerId = getFirstId(booking, bookingVendorFields);
      const verifiedOwnerId = serviceOwnerId || bookingOwnerId;

      if (verifiedOwnerId !== vendorId) {
        response.status(403).json({
          success: false,
          message: "You cannot update this booking.",
        });
        return;
      }

      if (normalizeBookingStatus(booking.status) !== "pending") {
        response.status(409).json({
          success: false,
          message: "Only pending bookings can be accepted or rejected.",
        });
        return;
      }

      const updateResult = await bookingsCollection.updateOne(
        {
          _id: booking._id,
          status: "pending",
        } as never,
        {
          $set: {
            status: decision,
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
          status: decision,
        },
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  return router;
}
