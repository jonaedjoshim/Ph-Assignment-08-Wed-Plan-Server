import { model, models, Schema, type InferSchemaType } from "mongoose";

const transactionStatuses = ["paid", "failed"] as const;

const transactionSchema = new Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    stripeInvoiceId: {
      type: String,
      required: true,
      unique: true,
    },
    stripeSubscriptionId: {
      type: String,
      required: true,
      index: true,
    },
    stripeCustomerId: {
      type: String,
      default: null,
      index: true,
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
    },
    status: {
      type: String,
      required: true,
      enum: [...transactionStatuses],
      index: true,
    },
    plan: {
      type: String,
      required: true,
      enum: ["premium"],
      default: "premium",
    },
    invoiceNumber: {
      type: String,
      default: null,
    },
    hostedInvoiceUrl: {
      type: String,
      default: null,
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

transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ status: 1, createdAt: -1 });

export type TransactionRecord = InferSchemaType<typeof transactionSchema>;

export const Transaction =
  models.Transaction ?? model("Transaction", transactionSchema);
