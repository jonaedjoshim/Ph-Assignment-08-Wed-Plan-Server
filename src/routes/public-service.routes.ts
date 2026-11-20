import { Router, type Response } from "express";
import mongoose from "mongoose";
import type { AuthInstance } from "../auth.js";
import {
  SERVICE_CATEGORIES,
  Service,
  type ServiceCategory,
  type ServiceRecord,
} from "../models/service.model.js";
import { requireAuth } from "../middleware/auth.middileware.js";

const SORT_OPTIONS = {
  newest: { createdAt: -1, _id: -1 },
  "price-asc": { price: 1, createdAt: -1, _id: -1 },
  "price-desc": { price: -1, createdAt: -1, _id: -1 },
} as const;

type SortOption = keyof typeof SORT_OPTIONS;

const PUBLIC_SERVICE_FIELDS =
  "vendorId serviceName category description price location images createdAt";

type VendorSummary = {
  id: string;
  name: string;
  businessName: string | null;
};

function isServiceCategory(value: string): value is ServiceCategory {
  return (SERVICE_CATEGORIES as readonly string[]).includes(value);
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

function parsePrice(value: unknown): {
  valid: boolean;
  value?: number;
} {
  if (value === undefined) {
    return { valid: true };
  }

  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)
  ) {
    return { valid: false };
  }

  const price = Number(value);

  if (!Number.isFinite(price)) {
    return { valid: false };
  }

  return { valid: true, value: price };
}

function sendDatabaseError(response: Response, error: unknown): void {
  console.error("Public service request failed.", error);
  response.status(500).json({
    success: false,
    message: "Unable to load services.",
  });
}

function isValidObjectId(value: string): boolean {
  return /^[a-fA-F0-9]{24}$/.test(value);
}

async function findVendors(
  vendorIds: string[],
): Promise<Map<string, VendorSummary>> {
  const vendors = new Map<string, VendorSummary>();
  const uniqueIds = [...new Set(vendorIds.filter(Boolean))];
  const db = mongoose.connection.db;

  if (uniqueIds.length === 0 || !db) {
    return vendors;
  }

  const objectIds = uniqueIds
    .filter((id) => isValidObjectId(id))
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
    const businessName =
      typeof user.businessName === "string" && user.businessName.trim()
        ? user.businessName.trim()
        : null;

    const summary: VendorSummary = {
      id: typeof user.id === "string" ? user.id : String(user._id),
      name: typeof user.name === "string" ? user.name : "",
      businessName,
    };

    vendors.set(summary.id, summary);
    vendors.set(String(user._id), summary);
  }

  return vendors;
}

function withVendor<T extends { vendorId: unknown }>(
  service: T,
  vendors: Map<string, VendorSummary>,
) {
  return {
    ...service,
    vendor: vendors.get(String(service.vendorId)) ?? null,
  };
}

export function createPublicServiceRouter(auth: AuthInstance) {
  const router = Router();

  router.get("/", async (req, res) => {
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

    const rawSearch = req.query.search;
    const rawLocation = req.query.location;

    if (
      (rawSearch !== undefined && typeof rawSearch !== "string") ||
      (rawLocation !== undefined && typeof rawLocation !== "string")
    ) {
      res.status(400).json({
        success: false,
        message: "Search and location must be single query values.",
      });
      return;
    }

    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";
    const location = typeof rawLocation === "string" ? rawLocation.trim() : "";

    if (search.length > 100 || location.length > 200) {
      res.status(400).json({
        success: false,
        message: "Search or location is too long.",
      });
      return;
    }

    const minPrice = parsePrice(req.query.minPrice);
    const maxPrice = parsePrice(req.query.maxPrice);

    if (!minPrice.valid || !maxPrice.valid) {
      res.status(400).json({
        success: false,
        message: "Price filters must be non-negative numbers.",
      });
      return;
    }

    if (
      minPrice.value !== undefined &&
      maxPrice.value !== undefined &&
      minPrice.value > maxPrice.value
    ) {
      res.status(400).json({
        success: false,
        message: "Minimum price cannot exceed maximum price.",
      });
      return;
    }

    const rawSort = req.query.sort ?? "newest";

    if (typeof rawSort !== "string" || !Object.hasOwn(SORT_OPTIONS, rawSort)) {
      res.status(400).json({
        success: false,
        message: "Sort must be newest, price-asc, or price-desc.",
      });
      return;
    }

    const sort = rawSort as SortOption;
    const page = parsePositiveInteger(req.query.page, 1, 10_000);
    const limit = parsePositiveInteger(req.query.limit, 12, 48);

    if (page === null || limit === null) {
      res.status(400).json({
        success: false,
        message: "Page or limit is invalid.",
      });
      return;
    }

    const filter: mongoose.QueryFilter<ServiceRecord> = {
      status: "approved",
      isActive: { $ne: false },
    };

    if (category) {
      filter.category = category;
    }

    if (search) {
      const searchPattern = new RegExp(escapeRegex(search), "i");

      filter.$or = [
        { serviceName: searchPattern },
        { description: searchPattern },
        { location: searchPattern },
      ];
    }

    if (location) {
      filter.location = {
        $regex: escapeRegex(location),
        $options: "i",
      };
    }

    if (minPrice.value !== undefined || maxPrice.value !== undefined) {
      filter.price = {};

      if (minPrice.value !== undefined) {
        filter.price.$gte = minPrice.value;
      }

      if (maxPrice.value !== undefined) {
        filter.price.$lte = maxPrice.value;
      }
    }

    try {
      const [services, total] = await Promise.all([
        Service.find(filter)
          .select(PUBLIC_SERVICE_FIELDS)
          .sort(SORT_OPTIONS[sort])
          .skip((page - 1) * limit)
          .limit(limit)
          .lean()
          .exec(),
        Service.countDocuments(filter).exec(),
      ]);

      const vendors = await findVendors(
        services.map((service) => String(service.vendorId)),
      );

      res.status(200).json({
        success: true,
        services: services.map((service) => withVendor(service, vendors)),
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

  router.get("/:serviceId", requireAuth(auth), async (req, res) => {
    const { serviceId } = req.params;

    if (!isValidObjectId(serviceId)) {
      res.status(400).json({
        success: false,
        message: "Invalid service ID.",
      });
      return;
    }

    try {
      const service = await Service.findOne({
        _id: serviceId,
        status: "approved",
        isActive: { $ne: false },
      })
        .select(PUBLIC_SERVICE_FIELDS)
        .lean()
        .exec();

      if (!service) {
        res.status(404).json({
          success: false,
          message: "Service not found.",
        });
        return;
      }

      const vendors = await findVendors([String(service.vendorId)]);

      res.status(200).json({
        success: true,
        service: withVendor(service, vendors),
      });
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  return router;
}
