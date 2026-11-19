import { model, models, Schema } from "mongoose";

export const SERVICE_CATEGORIES = [
  "Photography & Videography",
  "Wedding Venues",
  "Decoration & Florist",
  "Catering Services",
  "Makeup & Styling",
  "Wedding Fashion",
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

const serviceStatuses = ["pending", "approved", "rejected"] as const;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const serviceSchema = new Schema(
  {
    vendorId: {
      type: String,
      required: true,
      index: true,
    },
    serviceName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    category: {
      type: String,
      required: true,
      enum: [...SERVICE_CATEGORIES],
      index: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    location: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
      index: true,
    },
    images: {
      type: [String],
      default: [],
      validate: {
        validator: (images: string[]) =>
          images.length <= 10 && images.every(isHttpUrl),
        message: "Provide at most 10 valid HTTP or HTTPS image URLs.",
      },
    },
    status: {
      type: String,
      required: true,
      enum: [...serviceStatuses],
      default: "pending",
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

serviceSchema.index({ vendorId: 1, status: 1, createdAt: -1 });
serviceSchema.index({ status: 1, category: 1, createdAt: -1 });

export const Service = models.Service ?? model("Service", serviceSchema);
