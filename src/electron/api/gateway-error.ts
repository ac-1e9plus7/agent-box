export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'GatewayError'
  }
}
