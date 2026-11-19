import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import mongoose from "mongoose";
import { env } from "./config/env.js";

export type AccountRole = "customer" | "vendor" | "admin";

type PublicRole = Exclude<AccountRole, "admin">;

function isPublicRole(value: unknown): value is PublicRole {
  return value === "customer" || value === "vendor";
}

export function createAuth() {
  const database = mongoose.connection.db;

  if (!database) {
    throw new Error("Connect to MongoDB before initializing Better Auth.");
  }

  return betterAuth({
    baseURL: env.betterAuthUrl,
    secret: env.betterAuthSecret,
    database: mongodbAdapter(database),
    trustedOrigins: [env.clientUrl],

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },

    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "customer",
          input: false,
        },
        registrationRole: {
          type: "string",
          required: false,
          defaultValue: "customer",
          input: true,
        },
        businessName: {
          type: "string",
          required: false,
          defaultValue: "",
          input: true,
        },
        isBlocked: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
        },
        subscriptionPlan: {
          type: "string",
          required: false,
          defaultValue: "free",
          input: false,
        },
        subscriptionExpiresAt: {
          type: "date",
          required: false,
          input: false,
        },
      },
    },

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const submitted = user as typeof user & {
              registrationRole?: unknown;
              businessName?: unknown;
            };

            if (
              submitted.registrationRole !== undefined &&
              !isPublicRole(submitted.registrationRole)
            ) {
              throw new APIError("BAD_REQUEST", {
                message: "Account role must be customer or vendor.",
              });
            }

            const role = isPublicRole(submitted.registrationRole)
              ? submitted.registrationRole
              : "customer";

            const businessName =
              typeof submitted.businessName === "string"
                ? submitted.businessName.trim()
                : "";

            if (role === "vendor" && !businessName) {
              throw new APIError("BAD_REQUEST", {
                message: "Business name is required for vendor accounts.",
              });
            }

            return {
              data: {
                ...user,
                role,
                registrationRole: role,
                businessName: role === "vendor" ? businessName : "",
                isBlocked: false,
                subscriptionPlan: "free",
              },
            };
          },
        },
      },
    },

    ...(env.googleClientId && env.googleClientSecret
      ? {
          socialProviders: {
            google: {
              clientId: env.googleClientId,
              clientSecret: env.googleClientSecret,
            },
          },
        }
      : {}),
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;
