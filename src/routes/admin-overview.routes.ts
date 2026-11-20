import { Router } from "express";
import mongoose from "mongoose";
import type { AuthInstance } from "../auth.js";
import { requireAuth, requireRole } from "../middleware/auth.middileware.js";
import { Service } from "../models/service.model.js";

export function createAdminOverviewRouter(auth: AuthInstance) {
  const router = Router();

  router.use(requireAuth(auth), requireRole("admin"));

  router.get("/", async (_req, res) => {
    const database = mongoose.connection.db;

    if (!database) {
      res.status(500).json({
        success: false,
        message: "Database connection is unavailable.",
      });
      return;
    }

    try {
      const users = database.collection("user");
      const transactions = database.collection("transactions");

      const [
        totalUsers,
        totalCustomers,
        totalVendors,
        totalServices,
        pendingServices,
        totalTransactions,
      ] = await Promise.all([
        users.countDocuments({}),
        users.countDocuments({ role: "customer" }),
        users.countDocuments({ role: "vendor" }),
        Service.countDocuments({}),
        Service.countDocuments({ status: "pending" }),
        transactions.countDocuments({}),
      ]);

      res.status(200).json({
        success: true,
        overview: {
          totalUsers,
          totalCustomers,
          totalVendors,
          totalServices,
          pendingServices,
          totalTransactions,
        },
      });
    } catch (error) {
      console.error("Admin overview request failed.", error);

      res.status(500).json({
        success: false,
        message: "Unable to load the admin overview.",
      });
    }
  });

  return router;
}
