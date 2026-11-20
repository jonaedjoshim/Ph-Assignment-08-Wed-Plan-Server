import { createRemoteJWKSet, jwtVerify } from "jose";
import mongoose from "mongoose";
import type { Request, RequestHandler, Response } from "express";
import type { AccountRole, AuthInstance } from "../auth.js";
import { env } from "../config/env.js";

export type AuthenticatedUser = {
  id: string;
  name: string;
  email: string;
  role: AccountRole;
  subscriptionPlan: "free" | "premium";
};

const jwks = createRemoteJWKSet(new URL("/api/auth/jwks", env.betterAuthUrl));

function isAccountRole(value: unknown): value is AccountRole {
  return value === "customer" || value === "vendor" || value === "admin";
}

function hasActivePremiumSubscription(user: Record<string, unknown>): boolean {
  if (user.subscriptionPlan !== "premium") {
    return false;
  }

  const expiresAt = user.subscriptionExpiresAt;

  if (expiresAt === undefined || expiresAt === null) {
    return true;
  }

  const expiryTime =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : typeof expiresAt === "string"
        ? Date.parse(expiresAt)
        : typeof expiresAt === "number"
          ? expiresAt
          : Number.NaN;

  return Number.isFinite(expiryTime) && expiryTime > Date.now();
}

function parseAuthenticatedUser(value: unknown): AuthenticatedUser | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const user = value as Record<string, unknown>;

  if (
    typeof user.id !== "string" ||
    typeof user.name !== "string" ||
    typeof user.email !== "string" ||
    !isAccountRole(user.role)
  ) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    subscriptionPlan: hasActivePremiumSubscription(user) ? "premium" : "free",
  };
}

function getBearerToken(req: Request): string | null {
  const header = req.headers.authorization;

  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

async function findUserRecord(
  userId: string,
): Promise<Record<string, unknown> | null> {
  const database = mongoose.connection.db;

  if (!database) {
    throw new Error("Database is not connected.");
  }

  const candidates: Record<string, unknown>[] = [
    { id: userId },
    { _id: userId },
  ];

  if (mongoose.isValidObjectId(userId)) {
    candidates.push({ _id: new mongoose.Types.ObjectId(userId) });
  }

  return database.collection("user").findOne({ $or: candidates });
}

function toAuthenticatedUser(
  userId: string,
  record: Record<string, unknown>,
): AuthenticatedUser | null {
  const role = record.role;
  const name = record.name;
  const email = record.email;

  if (
    !isAccountRole(role) ||
    typeof name !== "string" ||
    typeof email !== "string"
  ) {
    return null;
  }

  return {
    id: userId,
    name,
    email,
    role,
    subscriptionPlan: hasActivePremiumSubscription(record) ? "premium" : "free",
  };
}

export function getAuthenticatedUser(
  response: Response,
): AuthenticatedUser | null {
  return parseAuthenticatedUser(response.locals.authenticatedUser);
}

export function requireAuth(_auth: AuthInstance): RequestHandler {
  return async (req, res, next) => {
    const token = getBearerToken(req);

    if (!token) {
      res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
      return;
    }

    let userId: string;

    try {
      const { payload } = await jwtVerify(token, jwks);

      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new Error("Token subject is missing.");
      }

      userId = payload.sub;
    } catch {
      res.status(401).json({
        success: false,
        message: "Your session token is invalid or has expired.",
      });
      return;
    }

    try {
      const record = await findUserRecord(userId);

      if (!record) {
        res.status(401).json({
          success: false,
          message: "Authentication is required.",
        });
        return;
      }

      if (record.isBlocked === true) {
        res.status(403).json({
          success: false,
          message: "This account has been blocked.",
        });
        return;
      }

      const user = toAuthenticatedUser(userId, record);

      if (!user) {
        res.status(403).json({
          success: false,
          message: "Account role is missing or invalid.",
        });
        return;
      }

      res.locals.authenticatedUser = user;
      next();
    } catch {
      res.status(500).json({
        success: false,
        message: "Unable to verify the session.",
      });
    }
  };
}

export function requireRole(...allowedRoles: AccountRole[]): RequestHandler {
  return (_req, res, next) => {
    const user = getAuthenticatedUser(res);

    if (!user) {
      res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
      return;
    }

    if (!allowedRoles.includes(user.role)) {
      res.status(403).json({
        success: false,
        message: "You do not have permission to access this resource.",
      });
      return;
    }

    next();
  };
}
