import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { connectDatabase } from "./config/database.js";
import { env } from "./config/env.js";

async function startServer(): Promise<void> {
  await connectDatabase();

  const auth = createAuth();
  const app = createApp(auth);

  app.listen(env.port, () => {
    console.info(`WedPlan API is running at http://localhost:${env.port}`);
  });
}

startServer().catch((error: unknown) => {
  console.error("Failed to start WedPlan API.", error);
  process.exitCode = 1;
});
