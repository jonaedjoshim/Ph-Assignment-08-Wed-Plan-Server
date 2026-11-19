import { Router, type Response } from "express";
import mongoose from "mongoose";
import type { AuthInstance } from "../auth.js";

import {
  SERVICE_CATEGORIES,
  Service,
  type ServiceCategory,
} from "../models/service.model.js";
import { AuthenticatedUser, getAuthenticatedUser, requireAuth, requireRole } from "../middleware/auth.middileware.js";

type ServiceInput = {
  serviceName: string;
  category: ServiceCategory;
  description: string;
  price: number;
  location: string;
  images?: string[];
};

type ParsedServiceInput = Partial<ServiceInput>;

type ParseResult =
  | { success: true; data: ParsedServiceInput }
  | { success: false; message: string };

const allowedFields = new Set([
  "serviceName",
  "category",
  "description",
  "price",
  "location",
  "images",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseServiceInput(body: unknown, partial: boolean): ParseResult {
  if (!isRecord(body)) {
    return { success: false, message: "A JSON object is required." };
  }

  const unsupportedField = Object.keys(body).find(
    (field) => !allowedFields.has(field),
  );

  if (unsupportedField) {
    return {
      success: false,
      message: `Field "${unsupportedField}" cannot be set.`,
    };
  }

  const data: ParsedServiceInput = {};

  if ("serviceName" in body) {
    const value = body.serviceName;

    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.trim().length > 120
    ) {
      return {
        success: false,
        message: "Service name must be between 1 and 120 characters.",
      };
    }

    data.serviceName = value.trim();
  }

  if ("category" in body) {
    const value = body.category;

    if (
      typeof value !== "string" ||
      !(SERVICE_CATEGORIES as readonly string[]).includes(value)
    ) {
      return { success: false, message: "A valid category is required." };
    }

    data.category = value as ServiceCategory;
  }

  if ("description" in body) {
    const value = body.description;

    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.trim().length > 5000
    ) {
      return {
        success: false,
        message: "Description must be between 1 and 5000 characters.",
      };
    }

    data.description = value.trim();
  }

  if ("price" in body) {
    const value = body.price;

    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return {
        success: false,
        message: "Price must be a non-negative number.",
      };
    }

    data.price = value;
  }

  if ("location" in body) {
    const value = body.location;

    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.trim().length > 200
    ) {
      return {
        success: false,
        message: "Location must be between 1 and 200 characters.",
      };
    }

    data.location = value.trim();
  }

  if ("images" in body) {
    const value = body.images;

    if (!Array.isArray(value) || value.length > 10) {
      return {
        success: false,
        message: "Images must be an array with at most 10 URLs.",
      };
    }

    const images: string[] = [];

    for (const image of value as unknown[]) {
      if (typeof image !== "string" || !isHttpUrl(image.trim())) {
        return {
          success: false,
          message: "Each image must have a valid HTTP or HTTPS URL.",
        };
      }

      images.push(image.trim());
    }

    data.images = images;
  }

  if (!partial) {
    const requiredFields = [
      "serviceName",
      "category",
      "description",
      "price",
      "location",
    ] as const;

    if (requiredFields.some((field) => !(field in data))) {
      return {
        success: false,
        message:
          "Service name, category, description, price, and location are required.",
      };
    }
  }

  if (partial && Object.keys(data).length === 0) {
    return {
      success: false,
      message: "Provide at least one service field to update.",
    };
  }

  return { success: true, data };
}

function isCompleteServiceInput(
  data: ParsedServiceInput,
): data is ServiceInput {
  return (
    typeof data.serviceName === "string" &&
    typeof data.category === "string" &&
    typeof data.description === "string" &&
    typeof data.price === "number" &&
    typeof data.location === "string"
  );
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
      message: "Only vendors can manage services.",
    });
    return null;
  }

  return user;
}

function sendDatabaseError(response: Response, error: unknown): void {
  if (error instanceof mongoose.Error.ValidationError) {
    response.status(400).json({
      success: false,
      message: "Service data failed validation.",
    });
    return;
  }

  console.error("Vendor service operation failed.", error);
  response.status(500).json({
    success: false,
    message: "Unable to complete the service request.",
  });
}

function isValidServiceId(id: string): boolean {
  return /^[a-fA-F0-9]{24}$/.test(id);
}

export function createVendorServiceRouter(auth: AuthInstance) {
  const router = Router();

  router.use(requireAuth(auth), requireRole("vendor"));

  router.get("/", async (_req, res) => {
    const user = getVendorUser(res);
    if (!user) return;

    try {
      const services = await Service.find({ vendorId: user.id })
        .sort({ createdAt: -1 })
        .lean();

      res.status(200).json({
        success: true,
        services,
      });
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  router.post("/", async (req, res) => {
    const user = getVendorUser(res);
    if (!user) return;

    const parsed = parseServiceInput(req.body, false);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: parsed.message,
      });
      return;
    }

    if (!isCompleteServiceInput(parsed.data)) {
      res.status(400).json({
        success: false,
        message: "Required service fields are missing.",
      });
      return;
    }

    try {
      if (user.subscriptionPlan === "free") {
        const activeServiceCount = await Service.countDocuments({
          vendorId: user.id,
          status: { $in: ["pending", "approved"] },
        });

        if (activeServiceCount >= 3) {
          res.status(403).json({
            success: false,
            code: "SERVICE_LIMIT_REACHED",
            message: "Free vendors can have at most 3 active services.",
          });
          return;
        }
      }

      const service = await Service.create({
        ...parsed.data,
        images: parsed.data.images ?? [],
        vendorId: user.id,
        status: "pending",
      });

      res.status(201).json({
        success: true,
        service,
      });
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  router.patch("/:serviceId", async (req, res) => {
    const user = getVendorUser(res);
    if (!user) return;

    if (!isValidServiceId(req.params.serviceId)) {
      res.status(400).json({
        success: false,
        message: "Invalid service ID.",
      });
      return;
    }

    const parsed = parseServiceInput(req.body, true);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: parsed.message,
      });
      return;
    }

    try {
      const service = await Service.findOne({
        _id: req.params.serviceId,
        vendorId: user.id,
      });

      if (!service) {
        res.status(404).json({
          success: false,
          message: "Service not found.",
        });
        return;
      }

      if (service.status === "rejected" && user.subscriptionPlan === "free") {
        const activeServiceCount = await Service.countDocuments({
          vendorId: user.id,
          status: { $in: ["pending", "approved"] },
        });

        if (activeServiceCount >= 3) {
          res.status(403).json({
            success: false,
            code: "SERVICE_LIMIT_REACHED",
            message:
              "You cannot resubmit this service while your free-plan limit is reached.",
          });
          return;
        }
      }

      Object.assign(service, parsed.data);
      service.status = "pending";

      await service.save();

      res.status(200).json({
        success: true,
        service,
      });
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  router.delete("/:serviceId", async (req, res) => {
    const user = getVendorUser(res);
    if (!user) return;

    if (!isValidServiceId(req.params.serviceId)) {
      res.status(400).json({
        success: false,
        message: "Invalid service ID.",
      });
      return;
    }

    try {
      const service = await Service.findOneAndDelete({
        _id: req.params.serviceId,
        vendorId: user.id,
      });

      if (!service) {
        res.status(404).json({
          success: false,
          message: "Service not found.",
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: "Service deleted.",
      });
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  return router;
}
