import { Router, type Response } from "express";
import mongoose from "mongoose";
import type { AuthInstance, AccountRole } from "../auth.js";
import { getActivePlan } from "../lib/subscription-plan.js";
import {
  getAuthenticatedUser,
  requireAuth,
  requireRole,
} from "../middleware/auth.middileware.js";

type RoleFilter = "all" | AccountRole;
type UserStatusFilter = "all" | "active" | "blocked";

const roleFilters = ["all", "customer", "vendor", "admin"] as const;
const userStatusFilters = ["all", "active", "blocked"] as const;

function isRoleFilter(value: string): value is RoleFilter {
  return (roleFilters as readonly string[]).includes(value);
}

function isUserStatusFilter(value: string): value is UserStatusFilter {
  return (userStatusFilters as readonly string[]).includes(value);
}

function isAccountRole(value: unknown): value is AccountRole {
  return value === "customer" || value === "vendor" || value === "admin";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function getUserId(user: Record<string, unknown>): string {
  if (typeof user.id === "string") {
    return user.id;
  }

  if (typeof user._id === "string") {
    return user._id;
  }

  if (user._id instanceof mongoose.Types.ObjectId) {
    return user._id.toHexString();
  }

  return "";
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    const date = new Date(value);

    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return null;
}

function toAdminUser(user: Record<string, unknown>) {
  return {
    id: getUserId(user),
    name: typeof user.name === "string" ? user.name : "",
    email: typeof user.email === "string" ? user.email : "",
    role: isAccountRole(user.role) ? user.role : "unknown",
    businessName:
      typeof user.businessName === "string" ? user.businessName : "",
    isBlocked: user.isBlocked === true,
    emailVerified: user.emailVerified === true,
    image: typeof user.image === "string" ? user.image : null,
    subscriptionPlan: getActivePlan(user),
    subscriptionExpiresAt: toIsoString(user.subscriptionExpiresAt),
    createdAt: toIsoString(user.createdAt),
  };
}

function createUserIdFilter(userId: string) {
  const alternatives: Record<string, unknown>[] = [
    { id: userId },
    { _id: userId },
  ];

  if (/^[a-fA-F0-9]{24}$/.test(userId)) {
    alternatives.push({
      _id: new mongoose.Types.ObjectId(userId),
    });
  }

  return { $or: alternatives };
}

function getUserCollection(response: Response) {
  const database = mongoose.connection.db;

  if (!database) {
    response.status(500).json({
      success: false,
      message: "Database connection is unavailable.",
    });
    return null;
  }

  return database.collection("user");
}

function sendDatabaseError(response: Response, error: unknown): void {
  console.error("Admin user operation failed.", error);

  response.status(500).json({
    success: false,
    message: "Unable to complete the user request.",
  });
}

export function createAdminUserRouter(auth: AuthInstance) {
  const router = Router();

  router.use(requireAuth(auth), requireRole("admin"));

  router.get("/", async (req, res) => {
    let roleFilter = "all";

    if (req.query.role !== undefined) {
      if (typeof req.query.role !== "string" || !isRoleFilter(req.query.role)) {
        res.status(400).json({
          success: false,
          message: "Role must be all, customer, vendor, or admin.",
        });
        return;
      }

      roleFilter = req.query.role;
    }

    let statusFilter = "all";

    if (req.query.status !== undefined) {
      if (
        typeof req.query.status !== "string" ||
        !isUserStatusFilter(req.query.status)
      ) {
        res.status(400).json({
          success: false,
          message: "Status must be all, active, or blocked.",
        });
        return;
      }

      statusFilter = req.query.status;
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

    const users = getUserCollection(res);
    if (!users) return;

    const filter: Record<string, unknown> = {};

    if (roleFilter !== "all") {
      filter.role = roleFilter;
    }

    if (statusFilter === "blocked") {
      filter.isBlocked = true;
    } else if (statusFilter === "active") {
      filter.isBlocked = { $ne: true };
    }

    if (search) {
      const pattern = new RegExp(escapeRegex(search), "i");

      filter.$or = [
        { name: pattern },
        { email: pattern },
        { businessName: pattern },
      ];
    }

    try {
      const [documents, total] = await Promise.all([
        users
          .find(filter, {
            projection: {
              _id: 1,
              id: 1,
              name: 1,
              email: 1,
              emailVerified: 1,
              image: 1,
              createdAt: 1,
              role: 1,
              businessName: 1,
              isBlocked: 1,
              subscriptionPlan: 1,
              subscriptionExpiresAt: 1,
            },
          })
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        users.countDocuments(filter),
      ]);

      res.status(200).json({
        success: true,
        users: documents
          .map((user) => toAdminUser(user))
          .filter((user) => user.id.length > 0),
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

  router.patch("/:userId/status", async (req, res) => {
    const userId = req.params.userId;

    if (
      userId.length === 0 ||
      userId.length > 200 ||
      userId.trim() !== userId
    ) {
      res.status(400).json({
        success: false,
        message: "Invalid user ID.",
      });
      return;
    }

    if (
      !isRecord(req.body) ||
      Object.keys(req.body).length !== 1 ||
      typeof req.body.isBlocked !== "boolean"
    ) {
      res.status(400).json({
        success: false,
        message: "isBlocked must be a boolean value.",
      });
      return;
    }

    const admin = getAuthenticatedUser(res);

    if (!admin) {
      res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
      return;
    }

    const isBlocked = req.body.isBlocked;

    if (isBlocked && userId === admin.id) {
      res.status(403).json({
        success: false,
        code: "CANNOT_BLOCK_SELF",
        message: "You cannot block your own admin account.",
      });
      return;
    }

    const users = getUserCollection(res);
    if (!users) return;

    const userFilter = createUserIdFilter(userId);

    try {
      const targetUser = await users.findOne(userFilter, {
        projection: {
          _id: 1,
          id: 1,
        },
      });

      if (!targetUser) {
        res.status(404).json({
          success: false,
          message: "User not found.",
        });
        return;
      }

      const targetUserId = getUserId(targetUser);

      if (isBlocked && targetUserId === admin.id) {
        res.status(403).json({
          success: false,
          code: "CANNOT_BLOCK_SELF",
          message: "You cannot block your own admin account.",
        });
        return;
      }

      const result = await users.updateOne(userFilter, {
        $set: {
          isBlocked,
          updatedAt: new Date(),
        },
      });

      if (result.matchedCount === 0) {
        res.status(404).json({
          success: false,
          message: "User not found.",
        });
        return;
      }

      res.status(200).json({
        success: true,
        user: {
          id: targetUserId || userId,
          isBlocked,
        },
        message: isBlocked ? "User blocked." : "User unblocked.",
      });
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  router.patch("/:userId/role", async (req, res) => {
    const userId = req.params.userId;

    if (
      userId.length === 0 ||
      userId.length > 200 ||
      userId.trim() !== userId
    ) {
      res.status(400).json({
        success: false,
        message: "Invalid user ID.",
      });
      return;
    }

    if (
      !isRecord(req.body) ||
      Object.keys(req.body).length !== 1 ||
      !isAccountRole(req.body.role)
    ) {
      res.status(400).json({
        success: false,
        message: "Role must be customer, vendor, or admin.",
      });
      return;
    }

    const admin = getAuthenticatedUser(res);

    if (!admin) {
      res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
      return;
    }

    const role = req.body.role;

    if (userId === admin.id && role !== "admin") {
      res.status(403).json({
        success: false,
        code: "CANNOT_CHANGE_OWN_ROLE",
        message: "You cannot change your own admin role.",
      });
      return;
    }

    const users = getUserCollection(res);
    if (!users) return;

    const userFilter = createUserIdFilter(userId);

    try {
      const targetUser = await users.findOne(userFilter, {
        projection: {
          _id: 1,
          id: 1,
        },
      });

      if (!targetUser) {
        res.status(404).json({
          success: false,
          message: "User not found.",
        });
        return;
      }

      const targetUserId = getUserId(targetUser);

      if (targetUserId === admin.id && role !== "admin") {
        res.status(403).json({
          success: false,
          code: "CANNOT_CHANGE_OWN_ROLE",
          message: "You cannot change your own admin role.",
        });
        return;
      }

      await users.updateOne(userFilter, {
        $set: {
          role,
          updatedAt: new Date(),
        },
      });

      res.status(200).json({
        success: true,
        user: {
          id: targetUserId || userId,
          role,
        },
        message: `User role updated to ${role}.`,
      });
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  return router;
}
