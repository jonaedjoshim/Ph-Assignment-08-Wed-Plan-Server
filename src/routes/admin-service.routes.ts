import { Router, type Response } from "express";
import mongoose from "mongoose";
import { AuthInstance } from "../auth.js";
import { requireAuth, requireRole } from "../middleware/auth.middileware.js";
import {
  SERVICE_CATEGORIES,
  Service,
  type ServiceCategory,
} from "../models/service.model.js";

const filterStatuses = ["all", "pending", "approved", "rejected"] as const;
const moderationStatuses = ["approved", "rejected"] as const;

type FilterStatus = (typeof filterStatuses)[number];
type ModerationStatus = (typeof moderationStatuses)[number];

function isFilterStatus(value: string): value is FilterStatus {
  return (filterStatuses as readonly string[]).includes(value);
}

function isModerationStatus(value: unknown): value is ModerationStatus {
  return (
    typeof value === "string" &&
    (moderationStatuses as readonly string[]).includes(value)
  );
}

function isServiceCategory(value: string): value is ServiceCategory {
  return (SERVICE_CATEGORIES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidServiceId(value: string): boolean {
  return /^[a-fA-F0-9]{24}$/.test(value);
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

function sendDatabaseError(response: Response, error: unknown): void {
  console.error("Admin service operation failed.", error);
  response.status(500).json({
    success: false,
    message: "Unable to complete the service request.",
  });
}

async function findVendorNames(
  vendorIds: string[],
): Promise<Map<string, string>> {
  const vendorNames = new Map<string, string>();
  const uniqueIds = [...new Set(vendorIds.filter(Boolean))];
  const db = mongoose.connection.db;

  if (uniqueIds.length === 0 || !db) {
    return vendorNames;
  }

  const objectIds = uniqueIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const users = await db
    .collection("user")
    .find(
      {
        $or: [{ id: { $in: uniqueIds } }, { _id: { $in: objectIds } }],
      },
      {
        projection: { id: 1, name: 1, businessName: 1 },
      },
    )
    .toArray();

  for (const user of users) {
    const displayName =
      typeof user.businessName === "string" && user.businessName.trim()
        ? user.businessName.trim()
        : typeof user.name === "string" && user.name.trim()
          ? user.name.trim()
          : null;

    if (!displayName) {
      continue;
    }

    const userId = typeof user.id === "string" ? user.id : String(user._id);

    vendorNames.set(userId, displayName);
    vendorNames.set(String(user._id), displayName);
  }

  return vendorNames;
}

export function createAdminServiceRouter(auth: AuthInstance) {
  const router = Router();

  router.use(requireAuth(auth), requireRole("admin"));

  router.get("/", async (req, res) => {
    let statusFilter = "pending";

    if (req.query.status !== undefined) {
      if (typeof req.query.status !== "string") {
        res.status(400).json({
          success: false,
          message: "Status must be a single query value.",
        });
        return;
      }

      statusFilter = req.query.status;
    }

    if (!isFilterStatus(statusFilter)) {
      res.status(400).json({
        success: false,
        message: "Status must be all, pending, approved, or rejected.",
      });
      return;
    }

    let category: ServiceCategory | undefined;

    if (req.query.category !== undefined) {
      if (typeof req.query.category !== "string") {
        res.status(400).json({
          success: false,
          message: "Category must be a single query value.",
        });
        return;
      }

      const categoryValue = req.query.category.trim();

      if (!isServiceCategory(categoryValue)) {
        res.status(400).json({
          success: false,
          message: "Invalid service category.",
        });
        return;
      }

      category = categoryValue;
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

    try {
      const query = Service.find({});

      if (statusFilter !== "all") {
        query.where("status").equals(statusFilter);
      }

      if (category) {
        query.where("category").equals(category);
      }

      if (search) {
        const pattern = new RegExp(escapeRegex(search), "i");

        query.or([
          { serviceName: pattern },
          { description: pattern },
          { location: pattern },
        ]);
      }

      const filter = query.getFilter();
      const [services, total] = await Promise.all([
        query
          .select(
            "vendorId serviceName category description price location images status createdAt updatedAt",
          )
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean()
          .exec(),
        Service.countDocuments(filter).exec(),
      ]);

      const vendorNames = await findVendorNames(
        services.map((service) => String(service.vendorId)),
      );

      const servicesWithVendor = services.map((service) => {
        const vendorName = vendorNames.get(String(service.vendorId));

        return vendorName ? { ...service, vendorName } : { ...service };
      });

      res.status(200).json({
        success: true,
        services: servicesWithVendor,
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

  router.patch("/:serviceId/status", async (req, res) => {
    const { serviceId } = req.params;

    if (!isValidServiceId(serviceId)) {
      res.status(400).json({
        success: false,
        message: "Invalid service ID.",
      });
      return;
    }

    if (
      !isRecord(req.body) ||
      Object.keys(req.body).length !== 1 ||
      !isModerationStatus(req.body.status)
    ) {
      res.status(400).json({
        success: false,
        message: 'Status must be either "approved" or "rejected".',
      });
      return;
    }

    try {
      const service = await Service.findById(serviceId).exec();

      if (!service) {
        res.status(404).json({
          success: false,
          message: "Service not found.",
        });
        return;
      }

      service.status = req.body.status;
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
    const { serviceId } = req.params;

    if (!isValidServiceId(serviceId)) {
      res.status(400).json({
        success: false,
        message: "Invalid service ID.",
      });
      return;
    }

    try {
      const service = await Service.findByIdAndDelete(serviceId).exec();

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
