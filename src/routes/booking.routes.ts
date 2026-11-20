import { Router, type Response } from "express";
import mongoose from "mongoose";
import type { AuthInstance } from "../auth.js";
import {
  getAuthenticatedUser,
  requireAuth,
  requireRole,
  type AuthenticatedUser,
} from "../middleware/auth.middileware.js";
import { Service } from "../models/service.model.js";
import { Booking } from "../models/booking.model.js";

type BookingInput = {
  serviceId: string;
  eventDate: Date;
  eventLocation: string;
  message: string;
};

type BookingParseResult =
  | { success: true; data: BookingInput }
  | { success: false; message: string };

const allowedBookingFields = new Set([
  "serviceId",
  "eventDate",
  "eventLocation",
  "message",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidObjectId(value: string): boolean {
  return /^[a-fA-F0-9]{24}$/.test(value);
}

function parseEventDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    return null;
  }

  return date;
}

function parseBookingInput(body: unknown): BookingParseResult {
  if (!isRecord(body)) {
    return { success: false, message: "A JSON object is required." };
  }

  const unsupportedField = Object.keys(body).find(
    (field) => !allowedBookingFields.has(field),
  );

  if (unsupportedField) {
    return {
      success: false,
      message: `Field "${unsupportedField}" cannot be set.`,
    };
  }

  const serviceId = body.serviceId;

  if (typeof serviceId !== "string" || !isValidObjectId(serviceId)) {
    return { success: false, message: "A valid service ID is required." };
  }

  const eventDate = parseEventDate(body.eventDate);

  if (!eventDate) {
    return {
      success: false,
      message: "Event date must be a valid date in YYYY-MM-DD format.",
    };
  }

  if (
    typeof body.eventLocation !== "string" ||
    body.eventLocation.trim().length === 0 ||
    body.eventLocation.trim().length > 200
  ) {
    return {
      success: false,
      message: "Event location must be between 1 and 200 characters.",
    };
  }

  const rawMessage = body.message;

  if (rawMessage !== undefined && typeof rawMessage !== "string") {
    return { success: false, message: "Message must be text." };
  }

  const message = typeof rawMessage === "string" ? rawMessage.trim() : "";

  if (message.length > 2000) {
    return {
      success: false,
      message: "Message cannot exceed 2000 characters.",
    };
  }

  return {
    success: true,
    data: {
      serviceId,
      eventDate,
      eventLocation: body.eventLocation.trim(),
      message,
    },
  };
}

function getBookingUser(response: Response): AuthenticatedUser | null {
  const user = getAuthenticatedUser(response);

  if (!user) {
    response.status(401).json({
      success: false,
      message: "Authentication is required.",
    });
    return null;
  }

  return user;
}

function sendDuplicateBooking(response: Response): void {
  response.status(409).json({
    success: false,
    code: "DUPLICATE_BOOKING",
    message: "A booking already exists for this service on this date.",
  });
}

function sendDatabaseError(response: Response, error: unknown): void {
  if (isRecord(error) && error.code === 11000) {
    sendDuplicateBooking(response);
    return;
  }

  if (error instanceof mongoose.Error.ValidationError) {
    response.status(400).json({
      success: false,
      message: "Booking data failed validation.",
    });
    return;
  }

  console.error("Booking operation failed.", error);

  response.status(500).json({
    success: false,
    message: "Unable to complete the booking request.",
  });
}

export function createBookingRouter(auth: AuthInstance) {
  const router = Router();

  router.use(requireAuth(auth));

  router.post("/", requireRole("customer"), async (req, res) => {
    const user = getBookingUser(res);
    if (!user) return;

    const parsed = parseBookingInput(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: parsed.message,
      });
      return;
    }

    try {
      const service = await Service.findOne({
        _id: parsed.data.serviceId,
        status: "approved",
        isActive: { $ne: false },
      }).select("_id vendorId");

      if (!service) {
        res.status(404).json({
          success: false,
          message: "Approved active service not found.",
        });
        return;
      }

      if (service.vendorId === user.id) {
        res.status(403).json({
          success: false,
          code: "SELF_BOOKING_NOT_ALLOWED",
          message: "You cannot book your own service.",
        });
        return;
      }

      const existingBooking = await Booking.exists({
        serviceId: service._id,
        eventDate: parsed.data.eventDate,
        status: { $in: ["pending", "accepted"] },
      });

      if (existingBooking) {
        sendDuplicateBooking(res);
        return;
      }

      const booking = await Booking.create({
        serviceId: service._id,
        vendorId: service.vendorId,
        customerId: user.id,
        eventDate: parsed.data.eventDate,
        eventLocation: parsed.data.eventLocation,
        message: parsed.data.message,
        status: "pending",
      });

      res.status(201).json({
        success: true,
        booking,
      });
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  router.get("/", requireRole("customer", "vendor"), async (_req, res) => {
    const user = getBookingUser(res);
    if (!user) return;

    if (user.role !== "customer" && user.role !== "vendor") {
      res.status(403).json({
        success: false,
        message: "You do not have permission to view bookings.",
      });
      return;
    }

    try {
      const filter =
        user.role === "customer"
          ? { customerId: user.id }
          : { vendorId: user.id };

      const bookings = await Booking.find(filter)
        .sort({ eventDate: 1, createdAt: -1 })
        .populate("serviceId", "serviceName category price location images")
        .lean();

      res.status(200).json({
        success: true,
        bookings,
      });
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  router.patch(
    "/:bookingId/cancel",
    requireRole("customer"),
    async (req, res) => {
      const user = getBookingUser(res);
      if (!user) return;

      const bookingId = req.params.bookingId;

      if (!isValidObjectId(bookingId)) {
        res.status(400).json({
          success: false,
          message: "Invalid booking ID.",
        });
        return;
      }

      try {
        const booking = await Booking.findOneAndUpdate(
          {
            _id: bookingId,
            customerId: user.id,
            status: "pending",
          },
          {
            $set: { status: "cancelled" },
          },
          {
            new: true,
            runValidators: true,
          },
        );

        if (booking) {
          res.status(200).json({
            success: true,
            booking,
          });
          return;
        }

        const ownedBooking = await Booking.exists({
          _id: bookingId,
          customerId: user.id,
        });

        if (!ownedBooking) {
          res.status(404).json({
            success: false,
            message: "Booking not found.",
          });
          return;
        }

        res.status(409).json({
          success: false,
          message: "Only pending bookings can be cancelled.",
        });
      } catch (error) {
        sendDatabaseError(res, error);
      }
    },
  );

  router.patch(
    "/:bookingId/status",
    requireRole("vendor"),
    async (req, res) => {
      const user = getBookingUser(res);
      if (!user) return;

      const bookingId = req.params.bookingId;

      if (!isValidObjectId(bookingId)) {
        res.status(400).json({
          success: false,
          message: "Invalid booking ID.",
        });
        return;
      }

      const body: unknown = req.body;

      if (!isRecord(body)) {
        res.status(400).json({
          success: false,
          message: "A JSON object is required.",
        });
        return;
      }

      const unsupportedField = Object.keys(body).find(
        (field) => field !== "status",
      );

      if (unsupportedField) {
        res.status(400).json({
          success: false,
          message: `Field "${unsupportedField}" cannot be set.`,
        });
        return;
      }

      const requestedStatus = body.status;

      if (requestedStatus !== "accepted" && requestedStatus !== "rejected") {
        res.status(400).json({
          success: false,
          message: 'Status must be either "accepted" or "rejected".',
        });
        return;
      }

      try {
        const booking = await Booking.findOneAndUpdate(
          {
            _id: bookingId,
            vendorId: user.id,
            status: "pending",
          },
          {
            $set: { status: requestedStatus },
          },
          {
            new: true,
            runValidators: true,
          },
        );

        if (booking) {
          res.status(200).json({
            success: true,
            booking,
          });
          return;
        }

        const ownedBooking = await Booking.exists({
          _id: bookingId,
          vendorId: user.id,
        });

        if (!ownedBooking) {
          res.status(404).json({
            success: false,
            message: "Booking not found.",
          });
          return;
        }

        res.status(409).json({
          success: false,
          message: "Only pending bookings can be accepted or rejected.",
        });
      } catch (error) {
        sendDatabaseError(res, error);
      }
    },
  );

  return router;
}
