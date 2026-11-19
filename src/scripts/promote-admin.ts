import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function promoteAdmin(): Promise<void> {
  const email = process.argv[2]?.trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(
      "Usage: npx tsx src/scripts/promote-admin.ts account@example.com",
    );
  }

  await connectDatabase();

  try {
    const database = mongoose.connection.db;

    if (!database) {
      throw new Error("MongoDB is not connected.");
    }

    const exactEmail = new RegExp(`^${escapeRegex(email)}$`, "i");
    const collectionNames = ["user", "users"];
    const matches: Array<{ collectionName: string; role: unknown }> = [];

    for (const collectionName of collectionNames) {
      const user = await database
        .collection(collectionName)
        .findOne({ email: exactEmail }, { projection: { role: 1 } });

      if (user) {
        matches.push({ collectionName, role: user.role });
      }
    }

    if (matches.length === 0) {
      throw new Error(
        "No account found for that email. Create the account first, then run this script.",
      );
    }

    if (matches.length > 1) {
      throw new Error(
        "More than one matching account was found. No account was changed.",
      );
    }

    const match = matches[0];

    if (match.role === "admin") {
      console.info("This account is already an admin.");
      return;
    }

    const result = await database
      .collection(match.collectionName)
      .updateOne({ email: exactEmail }, { $set: { role: "admin" } });

    if (result.matchedCount !== 1) {
      throw new Error("The account was not updated.");
    }

    console.info(`Promoted ${email} to admin.`);
    console.info("Sign out and sign back in for the new role to take effect.");
  } finally {
    await mongoose.disconnect();
  }
}

promoteAdmin().catch((error: unknown) => {
  console.error("Admin promotion failed.", error);
  process.exitCode = 1;
});
