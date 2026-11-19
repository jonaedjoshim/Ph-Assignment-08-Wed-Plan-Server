import { Router } from "express";
import type { AuthInstance } from "../auth.js";
import {
  getAuthenticatedUser,
  requireAuth,
} from "../middleware/auth.middileware.js";

export function createAccountRouter(auth: AuthInstance) {
  const router = Router();

  router.get("/me", requireAuth(auth), (_req, res) => {
    const user = getAuthenticatedUser(res);

    if (!user) {
      res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      user,
    });
  });

  return router;
}
