import { Router, type Response } from "express";
import mongoose from "mongoose";
import type { AuthInstance } from "../auth.js";
import {
  getAuthenticatedUser,
  requireAuth,
  requireRole,
  type AuthenticatedUser,
} from "../middleware/auth.middileware.js";
import { Service } from "../models/service.model.js";

type ServiceStatus = "pending" | "approved" | "rejected";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getVendorUser(response: Response): AuthenticatedUser | null {
  const user = getAuthenticatedUser(response);

  if (!user) {
    response.status(401).json({
      success: false,
      message: "Authentication is required.",
    });
    return null;
  }

  if (user.role !== "vendor") {
    response.status(403).json({
      success: false,
      message: "Only vendors can change service availability.",
    });
    return null;
  }

  return user;
}

function isValidServiceId(value: string): boolean {
  return /^[a-fA-F0-9]{24}$/.test(value);
}

function sendDatabaseError(response: Response, error: unknown): void {
  if (error instanceof mongoose.Error.ValidationError) {
    response.status(400).json({
      success: false,
      message: "Service data failed validation.",
    });
    return;
  }

  console.error("Vendor availability request failed.", error);

  response.status(500).json({
    success: false,
    message: "Unable to load or update service availability.",
  });
}

export function createVendorAvailabilityRouter(auth: AuthInstance) {
  const router = Router();

  router.use(requireAuth(auth), requireRole("vendor"));

  router.get("/", async (_request, response) => {
    const user = getVendorUser(response);
    if (!user) return;

    try {
      const services = await Service.find({ vendorId: user.id })
        .select("_id serviceName category location status isActive")
        .sort({ createdAt: -1, _id: -1 })
        .lean()
        .exec();

      response.status(200).json({
        success: true,
        services: services.map((service) => ({
          id: String(service._id),
          serviceName: service.serviceName,
          category: service.category,
          location: service.location,
          status: service.status as ServiceStatus,
          isActive: service.status === "approved" && service.isActive !== false,
        })),
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  router.patch("/:serviceId", async (request, response) => {
    const user = getVendorUser(response);
    if (!user) return;

    const serviceId = request.params.serviceId;

    if (!isValidServiceId(serviceId)) {
      response.status(400).json({
        success: false,
        message: "Service ID is invalid.",
      });
      return;
    }

    if (!isRecord(request.body) || typeof request.body.isActive !== "boolean") {
      response.status(400).json({
        success: false,
        message: "isActive must be a boolean.",
      });
      return;
    }

    const unsupportedField = Object.keys(request.body).find(
      (field) => field !== "isActive",
    );

    if (unsupportedField) {
      response.status(400).json({
        success: false,
        message: `Field "${unsupportedField}" cannot be set.`,
      });
      return;
    }

    try {
      const service = await Service.findOne({
        _id: serviceId,
        vendorId: user.id,
      });

      if (!service) {
        response.status(404).json({
          success: false,
          message: "Service was not found.",
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

      if (
        request.body.isActive &&
        service.isActive === false &&
        user.subscriptionPlan !== "premium"
      ) {
        const activeServiceCount = await Service.countDocuments({
          vendorId: user.id,
          _id: { $ne: service._id },
          status: { $in: ["pending", "approved"] },
          isActive: { $ne: false },
        }).exec();

        if (activeServiceCount >= 3) {
          response.status(403).json({
            success: false,
            code: "SERVICE_LIMIT_REACHED",
            message: "Free vendors can have at most 3 active services.",
          });
          return;
        }
      }

      service.isActive = request.body.isActive;
      await service.save();

      response.status(200).json({
        success: true,
        service: {
          id: String(service._id),
          isActive: service.isActive,
        },
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  return router;
}
