import mongoose, { type InferSchemaType } from "mongoose";

const transactionStatuses = ["pending", "paid", "failed", "expired"] as const;

const transactionSchema = new mongoose.Schema(
  {
    vendorId: {
      type: String,
      required: true,
      trim: true,
    },
    plan: {
      type: String,
      required: true,
      enum: ["starter", "premium"],
      default: "premium",
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      default: "usd",
    },
    status: {
      type: String,
      required: true,
      enum: [...transactionStatuses],
    },
    stripeSessionId: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    stripeInvoiceId: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    stripeSubscriptionId: {
      type: String,
      trim: true,
      index: true,
    },
    stripeCustomerId: {
      type: String,
      trim: true,
      index: true,
    },
    invoiceNumber: {
      type: String,
      trim: true,
    },
    hostedInvoiceUrl: {
      type: String,
      trim: true,
    },
    paidAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

transactionSchema.index({ vendorId: 1, createdAt: -1 });
transactionSchema.index({ status: 1, createdAt: -1 });

export type TransactionRecord = InferSchemaType<typeof transactionSchema>;

export const Transaction =
  mongoose.models.Transaction ??
  mongoose.model("Transaction", transactionSchema);
