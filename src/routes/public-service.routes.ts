import { Router, type Response } from "express";
import mongoose from "mongoose";
import type { AuthInstance } from "../auth.js";
import {
  SERVICE_CATEGORIES,
  Service,
  type ServiceCategory,
  type ServiceRecord,
} from "../models/service.model.js";

const SORT_OPTIONS = {
  newest: { createdAt: -1, _id: -1 },
  "price-asc": { price: 1, createdAt: -1, _id: -1 },
  "price-desc": { price: -1, createdAt: -1, _id: -1 },
} as const;

type SortOption = keyof typeof SORT_OPTIONS;

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

function isValidServiceId(value: string): boolean {
  return /^[a-fA-F0-9]{24}$/.test(value);
}

export function createPublicServiceRouter(_auth: AuthInstance) {
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
          .select(
            "vendorId serviceName category description price location images createdAt",
          )
          .sort(SORT_OPTIONS[sort])
          .skip((page - 1) * limit)
          .limit(limit)
          .lean()
          .exec(),
        Service.countDocuments(filter).exec(),
      ]);

      res.status(200).json({
        success: true,
        services,
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

  router.get("/:serviceId", async (req, res) => {
    const { serviceId } = req.params;

    if (!isValidServiceId(serviceId)) {
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
        .select(
          "vendorId serviceName category description price location images createdAt",
        )
        .lean()
        .exec();

      if (!service) {
        res.status(404).json({
          success: false,
          message: "Service not found.",
        });
        return;
      }

      res.status(200).json({
        success: true,
        service,
      });
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  return router;
}
