export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class ProteaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProteaError';
  }
}
