import { fromNodeHeaders } from "better-auth/node";
import type { RequestHandler, Response } from "express";
import type { AccountRole, AuthInstance } from "../auth.js";

export type AuthenticatedUser = {
  id: string;
  name: string;
  email: string;
  role: AccountRole;
};

function isAccountRole(value: unknown): value is AccountRole {
  return value === "customer" || value === "vendor" || value === "admin";
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
  };
}

export function getAuthenticatedUser(
  response: Response,
): AuthenticatedUser | null {
  return parseAuthenticatedUser(response.locals.authenticatedUser);
}

export function requireAuth(auth: AuthInstance): RequestHandler {
  return async (req, res, next) => {
    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });

      if (!session) {
        res.status(401).json({
          success: false,
          message: "Authentication is required.",
        });
        return;
      }

      const sessionUser = session.user as typeof session.user & {
        role?: unknown;
        isBlocked?: unknown;
      };

      if (sessionUser.isBlocked === true) {
        res.status(403).json({
          success: false,
          message: "This account has been blocked.",
        });
        return;
      }

      const user = parseAuthenticatedUser(sessionUser);

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
