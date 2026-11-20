import { Router, type Request, type Response } from "express";
import mongoose from "mongoose";
import type { AuthInstance } from "../auth.js";
import { requireAuth } from "../middleware/auth.middileware.js";

type ProfileRole = "customer" | "vendor" | "admin" | "unknown";

type Profile = {
  id: string;
  name: string;
  email: string;
  role: ProfileRole;
  businessName: string;
  phone: string;
  location: string;
  bio: string;
  updatedAt: string | null;
};

const profileProjection = {
  _id: 1,
  id: 1,
  name: 1,
  email: 1,
  role: 1,
  businessName: 1,
  phone: 1,
  location: 1,
  bio: 1,
  updatedAt: 1,
};

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

function isProfileRole(
  value: unknown,
): value is Exclude<ProfileRole, "unknown"> {
  return value === "customer" || value === "vendor" || value === "admin";
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

function createUserIdAlternatives(userId: string): Record<string, unknown>[] {
  const alternatives: Record<string, unknown>[] = [
    { id: userId },
    { _id: userId },
  ];

  if (/^[a-fA-F0-9]{24}$/.test(userId)) {
    alternatives.push({
      _id: new mongoose.Types.ObjectId(userId),
    });
  }

  return alternatives;
}

function toProfile(user: Record<string, unknown>, fallbackId: string): Profile {
  return {
    id: getId(user.id) || getId(user._id) || fallbackId,
    name: typeof user.name === "string" ? user.name : "",
    email: typeof user.email === "string" ? user.email : "",
    role: isProfileRole(user.role) ? user.role : "unknown",
    businessName:
      typeof user.businessName === "string" ? user.businessName : "",
    phone: typeof user.phone === "string" ? user.phone : "",
    location: typeof user.location === "string" ? user.location : "",
    bio: typeof user.bio === "string" ? user.bio : "",
    updatedAt: toIsoString(user.updatedAt),
  };
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
  console.error("Profile request failed.", error);

  response.status(500).json({
    success: false,
    message: "Unable to load or update the profile.",
  });
}

export function createProfileRouter(auth: AuthInstance) {
  const router = Router();

  router.use(requireAuth(auth));

  router.get("/", async (request, response) => {
    try {
      const userId = await getSessionUserId(auth, request);

      if (!userId) {
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
        .findOne({ $or: createUserIdAlternatives(userId) } as never, {
          projection: profileProjection,
        });

      if (!user) {
        response.status(404).json({
          success: false,
          message: "Profile was not found.",
        });
        return;
      }

      response.status(200).json({
        success: true,
        profile: toProfile(user as Record<string, unknown>, userId),
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  router.patch("/", async (request, response) => {
    try {
      const userId = await getSessionUserId(auth, request);

      if (!userId) {
        response.status(401).json({
          success: false,
          message: "Authentication is required.",
        });
        return;
      }

      if (!isRecord(request.body)) {
        response.status(400).json({
          success: false,
          message: "Profile fields are required.",
        });
        return;
      }

      const body = request.body;
      const allowedFields = new Set([
        "name",
        "businessName",
        "phone",
        "location",
        "bio",
      ]);

      if (Object.keys(body).some((key) => !allowedFields.has(key))) {
        response.status(400).json({
          success: false,
          message: "Only supported profile fields can be updated.",
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
        $or: createUserIdAlternatives(userId),
      };

      const existingUser = await users.findOne(userFilter as never, {
        projection: profileProjection,
      });

      if (!existingUser) {
        response.status(404).json({
          success: false,
          message: "Profile was not found.",
        });
        return;
      }

      const currentUser = existingUser as Record<string, unknown>;
      const isVendor = currentUser.role === "vendor";

      if (
        Object.prototype.hasOwnProperty.call(body, "businessName") &&
        !isVendor
      ) {
        response.status(403).json({
          success: false,
          message: "Only vendor accounts can update a business name.",
        });
        return;
      }

      const fieldLimits: Record<string, number> = {
        name: 100,
        businessName: 120,
        phone: 40,
        location: 200,
        bio: 1000,
      };

      const updates: Record<string, unknown> = {};
      const submittedFields = Object.keys(body);

      for (const field of submittedFields) {
        const value = body[field];

        if (typeof value !== "string") {
          response.status(400).json({
            success: false,
            message: `${field} must be text.`,
          });
          return;
        }

        const normalized = value.trim();
        const maximumLength = fieldLimits[field];

        if (normalized.length > maximumLength) {
          response.status(400).json({
            success: false,
            message: `${field} cannot exceed ${maximumLength} characters.`,
          });
          return;
        }

        if (field === "name" && normalized.length === 0) {
          response.status(400).json({
            success: false,
            message: "Name cannot be empty.",
          });
          return;
        }

        if (
          field === "phone" &&
          normalized.length > 0 &&
          !/^[+\d().\-\s]+$/.test(normalized)
        ) {
          response.status(400).json({
            success: false,
            message: "Enter a valid phone number.",
          });
          return;
        }

        updates[field] = normalized;
      }

      if (submittedFields.length === 0) {
        response.status(400).json({
          success: false,
          message: "Provide at least one profile field to update.",
        });
        return;
      }

      updates.updatedAt = new Date();

      const updateResult = await users.updateOne(
        userFilter as never,
        { $set: updates } as never,
      );

      if (updateResult.matchedCount !== 1) {
        response.status(404).json({
          success: false,
          message: "Profile was not found.",
        });
        return;
      }

      const updatedUser = await users.findOne(userFilter as never, {
        projection: profileProjection,
      });

      if (!updatedUser) {
        response.status(404).json({
          success: false,
          message: "Profile was not found after updating.",
        });
        return;
      }

      response.status(200).json({
        success: true,
        profile: toProfile(updatedUser as Record<string, unknown>, userId),
      });
    } catch (error) {
      sendDatabaseError(response, error);
    }
  });

  return router;
}
