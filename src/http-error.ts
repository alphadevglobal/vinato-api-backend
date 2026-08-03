export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string | string[],
    public readonly error: string,
  ) {
    super(Array.isArray(message) ? message.join(", ") : message);
    this.responseMessage = message;
  }

  readonly responseMessage: string | string[];

  toJSON() {
    return {
      message: this.responseMessage,
      error: this.error,
      statusCode: this.statusCode,
    };
  }
}

export const badRequest = (message: string | string[]) =>
  new HttpError(400, message, "Bad Request");

export const notFound = (message: string) =>
  new HttpError(404, message, "Not Found");

export const internalServerError = (message: string) =>
  new HttpError(500, message, "Internal Server Error");
