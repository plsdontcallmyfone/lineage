export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const bad = (code: string, message: string) => new ApiError(400, code, message);
export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const forbidden = (code: string, message: string) => new ApiError(403, code, message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
