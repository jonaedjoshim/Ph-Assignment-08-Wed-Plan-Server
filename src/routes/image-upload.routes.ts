import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { AuthInstance } from "../auth.js";
import { requireAuth, requireRole } from "../middleware/auth.middileware.js";

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_SIZE_BYTES,
    files: 1,
  },
  fileFilter(_request, file, callback) {
    if (!allowedImageTypes.has(file.mimetype)) {
      callback(new Error("Only JPEG, PNG, and WebP images are allowed."));
      return;
    }

    callback(null, true);
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function hasValidImageSignature(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "image/jpeg") {
    return (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  }

  if (mimeType === "image/png") {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    return (
      buffer.length >= signature.length &&
      buffer.subarray(0, signature.length).equals(signature)
    );
  }

  if (mimeType === "image/webp") {
    return (
      buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    );
  }

  return false;
}

function sendUploadMiddlewareError(response: Response, error: unknown): void {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      response.status(413).json({
        success: false,
        message: "Each image must be 5 MB or smaller.",
      });
      return;
    }

    response.status(400).json({
      success: false,
      message: "The image upload is invalid.",
    });
    return;
  }

  response.status(400).json({
    success: false,
    message:
      error instanceof Error ? error.message : "The image upload is invalid.",
  });
}

async function handleImageUpload(
  request: Request,
  response: Response,
): Promise<void> {
  const file = request.file;

  if (!file) {
    response.status(400).json({
      success: false,
      message: "Choose an image to upload.",
    });
    return;
  }

  if (!hasValidImageSignature(file.buffer, file.mimetype)) {
    response.status(400).json({
      success: false,
      message: "The uploaded file is not a valid JPEG, PNG, or WebP image.",
    });
    return;
  }

  const apiKey = process.env.IMGBB_API_KEY?.trim();

  if (!apiKey) {
    response.status(503).json({
      success: false,
      message: "Image uploads are not configured.",
    });
    return;
  }

  const uploadUrl = new URL("https://api.imgbb.com/1/upload");
  uploadUrl.searchParams.set("key", apiKey);

  const body = new URLSearchParams({
    image: file.buffer.toString("base64"),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const upstreamResponse = await fetch(uploadUrl, {
      method: "POST",
      body,
      signal: controller.signal,
    });

    const payload: unknown = await upstreamResponse.json().catch(() => null);

    if (
      !upstreamResponse.ok ||
      !isRecord(payload) ||
      payload.success !== true ||
      !isRecord(payload.data)
    ) {
      response.status(502).json({
        success: false,
        message: "ImgBB could not process the image upload.",
      });
      return;
    }

    const url = toHttpsUrl(payload.data.url);

    if (!url) {
      response.status(502).json({
        success: false,
        message: "ImgBB returned an invalid image URL.",
      });
      return;
    }

    response.status(201).json({
      success: true,
      url,
    });
  } catch (error) {
    console.error("ImgBB image upload failed.", error);

    response.status(502).json({
      success: false,
      message: "Image upload failed. Please try again.",
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function createImageUploadRouter(auth: AuthInstance) {
  const router = Router();

  router.post(
    "/",
    requireAuth(auth),
    requireRole("vendor"),
    (request, response) => {
      imageUpload.single("image")(request, response, (error) => {
        if (error) {
          sendUploadMiddlewareError(response, error);
          return;
        }

        void handleImageUpload(request, response);
      });
    },
  );

  return router;
}
