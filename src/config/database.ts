import { setServers } from "node:dns";
import mongoose from "mongoose";
import { env } from "./env.js";

if (process.env.NODE_ENV !== "production") {
  setServers(["8.8.8.8", "8.8.4.4"]);
}

export async function connectDatabase(): Promise<void> {
  await mongoose.connect(env.mongodbUri);
  console.info(`Connected to MongoDB database: ${mongoose.connection.name}`);
}
