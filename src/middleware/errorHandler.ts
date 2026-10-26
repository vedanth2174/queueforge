import type { ErrorRequestHandler } from "express";

type HttpError = Error & {
  status?: number;
  type?: string;
};

export const apiErrorHandler: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  _next,
) => {
  const candidate = error as HttpError;

  if (
    error instanceof SyntaxError &&
    candidate.status === 400 &&
    candidate.type === "entity.parse.failed"
  ) {
    return res.status(400).json({
      error: "Malformed JSON request",
    });
  }

  if (candidate?.status === 413 || candidate?.type === "entity.too.large") {
    return res.status(413).json({
      error: "Request body too large",
    });
  }

  console.error("Unhandled API error:", error);
  return res.status(500).json({
    error: "Internal server error",
  });
};
