import { AppError, ErrorCodes } from '../domain/errors.ts';

export interface PageParams {
  limit: number;
  offset: number;
}

export function parsePage(query: Record<string, unknown>): PageParams {
  const rawLimit = query.limit ?? 50;
  const rawOffset = query.offset ?? 0;
  const limit = Number(rawLimit);
  const offset = Number(rawOffset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new AppError(ErrorCodes.VALIDATION, 'limit must be an integer between 1 and 500');
  if (!Number.isInteger(offset) || offset < 0)
    throw new AppError(ErrorCodes.VALIDATION, 'offset must be a non-negative integer');
  return { limit, offset };
}

export interface Paginated<T> {
  data: T[];
  pagination: { limit: number; offset: number; hasMore: boolean };
}

export function paginate<T>(rows: T[], page: PageParams): Paginated<T> {
  return {
    data: rows,
    pagination: { limit: page.limit, offset: page.offset, hasMore: rows.length >= page.limit },
  };
}
