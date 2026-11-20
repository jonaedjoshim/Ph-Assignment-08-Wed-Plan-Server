import mongoose, { type InferSchemaType } from "mongoose";

export const BOOKING_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "cancelled",
] as const;

const bookingSchema = new mongoose.Schema(
  {
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
    },
    vendorId: {
      type: String,
      required: true,
    },
    customerId: {
      type: String,
      required: true,
    },
    eventDate: {
      type: Date,
      required: true,
    },
    eventLocation: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    message: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },
    status: {
      type: String,
      required: true,
      enum: [...BOOKING_STATUSES],
      default: "pending",
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

bookingSchema.index(
  { serviceId: 1, eventDate: 1 },
  {
    unique: true,
    name: "unique_active_service_booking_date",
    partialFilterExpression: {
      status: { $in: ["pending", "accepted"] },
    },
  },
);

bookingSchema.index({ customerId: 1, createdAt: -1 });
bookingSchema.index({ vendorId: 1, status: 1, eventDate: 1 });

export type BookingRecord = InferSchemaType<typeof bookingSchema>;

export const Booking =
  mongoose.models.Booking ?? mongoose.model("Booking", bookingSchema);
