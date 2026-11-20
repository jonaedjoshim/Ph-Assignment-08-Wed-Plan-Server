import { Router, type Request, type Response } from "express";
import mongoose from "mongoose";
import type { AuthInstance } from "../auth.js";
import { requireAuth, requireRole } from "../middleware/auth.middileware.js";

type ServiceStatus = "pending" | "approved" | "rejected";

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

function matchesOwner(
  record: Record<string, unknown>,
  vendorId: string,
): boolean {
  return serviceOwnerFields.some(
    (field) => getId(getFieldValue(record, field)) === vendorId,
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

function isServiceStatus(value: unknown): value is ServiceStatus {
  return value === "pending" || value === "approved" || value === "rejected";
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
  console.error("Vendor availability request failed.", error);

  response.status(500).json({
    success: false,
    message: "Unable to load or update service availability.",
  });
}

export function createVendorAvailabilityRouter(auth: AuthInstance) {
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

      const documents = await database
        .collection("services")
        .find({
          $or: createIdAlternatives(serviceOwnerFields, vendorId),
        } as never)
        .sort({ createdAt: -1, _id: -1 })
        .toArray();

      const services = documents
        .map((document) => document as Record<string, unknown>)
        .filter((service) => matchesOwner(service, vendorId))
        .filter((service) => isServiceStatus(service.status))
        .map((service) => {
          const status = service.status as ServiceStatus;

          return {
            id: getDocumentId(service),
            serviceName:
              getString(service.serviceName) ??
              getString(service.name) ??
              "Untitled service",
            category: getString(service.category) ?? "",
            location: getString(service.location) ?? "",
            status,
            isActive: status === "approved" && service.isActive !== false,
          };
        })
        .filter((service) => service.id.length > 0);

      response.status(200).json({
        success: true,
        services,
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  router.patch("/:serviceId", async (request, response) => {
    try {
      const vendorId = await getSessionUserId(auth, request);

      if (!vendorId) {
        response.status(401).json({
          success: false,
          message: "Authentication is required.",
        });
        return;
      }

      const serviceId = request.params.serviceId;

      if (!serviceId || serviceId.length > 100) {
        response.status(400).json({
          success: false,
          message: "Service ID is invalid.",
        });
        return;
      }

      if (
        !isRecord(request.body) ||
        typeof request.body.isActive !== "boolean"
      ) {
        response.status(400).json({
          success: false,
          message: "isActive must be a boolean.",
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

      const services = database.collection("services");
      const idAlternatives = createIdAlternatives(["_id"], serviceId);

      const document = await services.findOne({
        $or: idAlternatives,
      } as never);

      if (!document) {
        response.status(404).json({
          success: false,
          message: "Service was not found.",
        });
        return;
      }

      const service = document as Record<string, unknown>;

      if (!matchesOwner(service, vendorId)) {
        response.status(403).json({
          success: false,
          message: "You cannot change availability for this service.",
        });
        return;
      }

      if (service.status !== "approved") {
        response.status(409).json({
          success: false,
          message: "Only approved services can change availability.",
        });
        return;
      }

      const updateResult = await services.updateOne(
        {
          _id: service._id,
          status: "approved",
          $or: createIdAlternatives(serviceOwnerFields, vendorId),
        } as never,
        {
          $set: {
            isActive: request.body.isActive,
            updatedAt: new Date(),
          },
        },
      );

      if (updateResult.matchedCount !== 1) {
        response.status(409).json({
          success: false,
          message: "The service changed. Refresh and try again.",
        });
        return;
      }

      response.status(200).json({
        success: true,
        service: {
          id: serviceId,
          isActive: request.body.isActive,
        },
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  return router;
}
