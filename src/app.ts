import { toNodeHandler } from "better-auth/node";
import cors from "cors";
import express from "express";
import type { createAuth } from "./auth.js";
import { env } from "./config/env.js";
import { healthRouter } from "./routes/health.routes.js";

type AuthInstance = ReturnType<typeof createAuth>;

export function createApp(auth: AuthInstance) {
  const app = express();

  app.use(
    cors({
      origin: env.clientUrl,
      credentials: true,
    }),
  );

  app.all("/api/auth/*", toNodeHandler(auth));

  app.use(express.json({ limit: "1mb" }));
  app.use("/api/health", healthRouter);

  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      message: "API route not found.",
    });
  });

  return app;
}
