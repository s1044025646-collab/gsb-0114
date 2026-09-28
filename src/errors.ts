export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "EDGE_IN_USE"
  | "EDGE_NOT_INSTALLED"
  | "WORKORDER_CLOSED"
  | "GAUGE_EXPIRED"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number = 400
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError("NOT_FOUND", `${what} not found`, 404);
export const conflict = (msg: string) => new AppError("CONFLICT", msg, 409);
