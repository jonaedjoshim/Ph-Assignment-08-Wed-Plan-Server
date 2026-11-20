import { toNodeHandler } from "better-auth/node";
import cors from "cors";
import express from "express";
import type { AuthInstance } from "./auth.js";
import { env } from "./config/env.js";
import { createAccountRouter } from "./routes/account.routes.js";
import { createAdminOverviewRouter } from "./routes/admin-overview.routes.js";
import { createAdminServiceRouter } from "./routes/admin-service.routes.js";
import { createAdminTransactionRouter } from "./routes/admin-transaction.routes.js";
import { createAdminUserRouter } from "./routes/admin-user.routes.js";
import { createBookingRouter } from "./routes/booking.routes.js";
import { healthRouter } from "./routes/health.routes.js";
import { createPublicServiceRouter } from "./routes/public-service.routes.js";
import { createStripeRouter } from "./routes/stripe.routes.js";
import { createVendorServiceRouter } from "./routes/vendor-service.routes.js";

export function createApp(auth: AuthInstance) {
  const app = express();

  app.use(
    cors({
      origin: env.clientUrl,
      credentials: true,
    }),
  );

  app.all("/api/auth/*", toNodeHandler(auth));

  app.use("/api/stripe", createStripeRouter(auth));

  app.use(
    express.json({
      limit: "1mb",
    }),
  );

  app.use("/api/health", healthRouter);
  app.use("/api/account", createAccountRouter(auth));
  app.use("/api/services", createPublicServiceRouter(auth));
  app.use("/api/vendor/services", createVendorServiceRouter(auth));
  app.use("/api/admin/overview", createAdminOverviewRouter(auth));
  app.use("/api/admin/users", createAdminUserRouter(auth));
  app.use("/api/admin/services", createAdminServiceRouter(auth));
  app.use("/api/admin/transactions", createAdminTransactionRouter(auth));
  app.use("/api/bookings", createBookingRouter(auth));

  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      message: "API route not found.",
    });
  });

  return app;
}
