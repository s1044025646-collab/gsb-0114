import { AppError, ErrorCodes } from './errors.ts';

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(ErrorCodes.VALIDATION, `${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

export function requirePositiveInt(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new AppError(ErrorCodes.VALIDATION, `${field} must be a positive integer`, { field });
  }
  return n;
}

export function requireNumber(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new AppError(ErrorCodes.VALIDATION, `${field} must be a finite number`, { field });
  }
  return n;
}

export function requireIso(value: unknown, field: string): string {
  const s = requireString(value, field);
  if (Number.isNaN(Date.parse(s))) {
    throw new AppError(ErrorCodes.VALIDATION, `${field} must be an ISO-8601 timestamp`, { field });
  }
  return new Date(s).toISOString();
}

export function optionalIso(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireIso(value, field);
}

export function check(cond: boolean, message: string, details?: unknown): void {
  if (!cond) throw new AppError(ErrorCodes.VALIDATION, message, details);
}
