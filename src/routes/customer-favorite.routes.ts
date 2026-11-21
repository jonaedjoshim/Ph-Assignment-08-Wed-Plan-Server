import { Router, type Response } from "express";
import mongoose from "mongoose";
import type { AuthInstance } from "../auth.js";
import {
  getAuthenticatedUser,
  requireAuth,
  requireRole,
} from "../middleware/auth.middileware.js";
import { Service } from "../models/service.model.js";
import { findVendors, withVendor } from "./public-service.routes.js";

const MAX_FAVORITES = 100;
const FAVORITE_FIELDS =
  "vendorId serviceName category description price location images createdAt";

function isValidObjectId(value: string): boolean {
  return /^[a-fA-F0-9]{24}$/.test(value);
}

function createUserIdAlternatives(userId: string): Record<string, unknown>[] {
  const alternatives: Record<string, unknown>[] = [
    { id: userId },
    { _id: userId },
  ];

  if (isValidObjectId(userId)) {
    alternatives.push({ _id: new mongoose.Types.ObjectId(userId) });
  }

  return alternatives;
}

function getFavoriteIds(user: Record<string, unknown> | null): string[] {
  if (!user || !Array.isArray(user.favoriteServiceIds)) {
    return [];
  }

  return user.favoriteServiceIds.filter(
    (value): value is string =>
      typeof value === "string" && isValidObjectId(value),
  );
}

function sendDatabaseError(response: Response, error: unknown): void {
  console.error("Customer favorites request failed.", error);

  response.status(500).json({
    success: false,
    message: "Unable to load or update saved services.",
  });
}

export function createCustomerFavoriteRouter(auth: AuthInstance) {
  const router = Router();

  router.use(requireAuth(auth), requireRole("customer"));

  router.get("/ids", async (request, response) => {
    try {
      const customerId = getAuthenticatedUser(response)?.id ?? null;

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

      const user = await database
        .collection("user")
        .findOne({ $or: createUserIdAlternatives(customerId) } as never, {
          projection: { favoriteServiceIds: 1 },
        });

      response.status(200).json({
        success: true,
        ids: getFavoriteIds(user),
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  router.get("/", async (request, response) => {
    try {
      const customerId = getAuthenticatedUser(response)?.id ?? null;

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

      const user = await database
        .collection("user")
        .findOne({ $or: createUserIdAlternatives(customerId) } as never, {
          projection: { favoriteServiceIds: 1 },
        });

      const ids = getFavoriteIds(user);

      if (ids.length === 0) {
        response.status(200).json({
          success: true,
          services: [],
          ids: [],
        });
        return;
      }

      const services = await Service.find({
        _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) },
        status: "approved",
        isActive: { $ne: false },
      })
        .select(FAVORITE_FIELDS)
        .lean()
        .exec();

      const order = new Map(ids.map((id, index) => [id, index]));
      const ordered = [...services].sort((left, right) => {
        const leftIndex = order.get(String(left._id)) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex =
          order.get(String(right._id)) ?? Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex;
      });

      const vendors = await findVendors(
        ordered.map((service) => String(service.vendorId)),
      );

      const availableIds = ordered.map((service) => String(service._id));

      response.status(200).json({
        success: true,
        services: ordered.map((service) => withVendor(service, vendors)),
        ids: availableIds,
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  router.post("/:serviceId", async (request, response) => {
    const { serviceId } = request.params;

    if (!isValidObjectId(serviceId)) {
      response.status(400).json({
        success: false,
        message: "Invalid service ID.",
      });
      return;
    }

    try {
      const customerId = getAuthenticatedUser(response)?.id ?? null;

      if (!customerId) {
        response.status(401).json({
          success: false,
          message: "Authentication is required.",
        });
        return;
      }

      const service = await Service.findOne({
        _id: new mongoose.Types.ObjectId(serviceId),
        status: "approved",
        isActive: { $ne: false },
      })
        .select("_id")
        .lean()
        .exec();

      if (!service) {
        response.status(404).json({
          success: false,
          message: "Service not found.",
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

      const users = database.collection("user");
      const userFilter = {
        $or: createUserIdAlternatives(customerId),
      };

      const user = await users.findOne(userFilter as never, {
        projection: { favoriteServiceIds: 1 },
      });

      if (!user) {
        response.status(404).json({
          success: false,
          message: "Account not found.",
        });
        return;
      }

      const ids = getFavoriteIds(user);

      if (ids.includes(serviceId)) {
        response.status(200).json({ success: true, ids });
        return;
      }

      if (ids.length >= MAX_FAVORITES) {
        response.status(400).json({
          success: false,
          message: `You can save up to ${MAX_FAVORITES} services.`,
        });
        return;
      }

      await users.updateOne(userFilter as never, {
        $addToSet: { favoriteServiceIds: serviceId },
      });

      response.status(200).json({
        success: true,
        ids: [...ids, serviceId],
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  router.delete("/:serviceId", async (request, response) => {
    const { serviceId } = request.params;

    if (!isValidObjectId(serviceId)) {
      response.status(400).json({
        success: false,
        message: "Invalid service ID.",
      });
      return;
    }

    try {
      const customerId = getAuthenticatedUser(response)?.id ?? null;

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

      const users = database.collection("user");
      const userFilter = {
        $or: createUserIdAlternatives(customerId),
      };

      const user = await users.findOne(userFilter as never, {
        projection: { favoriteServiceIds: 1 },
      });

      if (!user) {
        response.status(404).json({
          success: false,
          message: "Account not found.",
        });
        return;
      }

      await users.updateOne(userFilter as never, {
        $pull: { favoriteServiceIds: serviceId },
      } as never);

      response.status(200).json({
        success: true,
        ids: getFavoriteIds(user).filter((id) => id !== serviceId),
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  return router;
}
