export class ApiFault extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiFault';
  }
}

export const notFound = () => new ApiFault(404, 'NOT_FOUND', 'Resource was not found.');
export const unavailable = () =>
  new ApiFault(503, 'DEPENDENCY_UNAVAILABLE', 'A required service is unavailable.');
