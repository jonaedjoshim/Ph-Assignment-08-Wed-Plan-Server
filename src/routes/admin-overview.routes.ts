import { Router } from "express";
import mongoose from "mongoose";
import type { AuthInstance } from "../auth.js";
import { requireAuth, requireRole } from "../middleware/auth.middileware.js";
import { Service } from "../models/service.model.js";

export function createAdminOverviewRouter(auth: AuthInstance) {
  const router = Router();

  router.use(requireAuth(auth), requireRole("admin"));

  router.get("/", async (_request, response) => {
    const database = mongoose.connection.db;

    if (!database) {
      response.status(500).json({
        success: false,
        message: "Database connection is unavailable.",
      });
      return;
    }

    try {
      const users = database.collection("user");
      const transactions = database.collection("transactions");
      const bookings = database.collection("bookings");

      const [
        totalUsers,
        customers,
        vendors,
        admins,
        totalServices,
        pendingServices,
        approvedServices,
        rejectedServices,
        totalTransactions,
        paidTransactions,
        failedTransactions,
        totalBookings,
        pendingBookings,
        acceptedBookings,
        rejectedBookings,
        cancelledBookings,
      ] = await Promise.all([
        users.countDocuments({}),
        users.countDocuments({ role: "customer" }),
        users.countDocuments({ role: "vendor" }),
        users.countDocuments({ role: "admin" }),
        Service.countDocuments({}),
        Service.countDocuments({ status: "pending" }),
        Service.countDocuments({ status: "approved" }),
        Service.countDocuments({ status: "rejected" }),
        transactions.countDocuments({}),
        transactions.countDocuments({ status: "paid" }),
        transactions.countDocuments({ status: "failed" }),
        bookings.countDocuments({}),
        bookings.countDocuments({ status: "pending" }),
        bookings.countDocuments({ status: "accepted" }),
        bookings.countDocuments({ status: "rejected" }),
        bookings.countDocuments({ status: "cancelled" }),
      ]);

      const stats = {
        users: {
          total: totalUsers,
          customers,
          vendors,
          admins,
        },
        services: {
          total: totalServices,
          pending: pendingServices,
          approved: approvedServices,
          rejected: rejectedServices,
          active: approvedServices,
        },
        transactions: {
          total: totalTransactions,
          paid: paidTransactions,
          failed: failedTransactions,
        },
        bookings: {
          total: totalBookings,
          pending: pendingBookings,
          accepted: acceptedBookings,
          rejected: rejectedBookings,
          cancelled: cancelledBookings,
        },
      };

      response.status(200).json({
        success: true,
        stats,
        overview: {
          totalUsers,
          totalCustomers: customers,
          totalVendors: vendors,
          totalAdmins: admins,
          totalServices,
          pendingServices,
          totalTransactions,
        },
      });
    } catch (error) {
      console.error("Admin overview request failed.", error);

      response.status(500).json({
        success: false,
        message: "Unable to load the admin overview.",
      });
    }
  });

  return router;
}
