/** A typed failure raised by a persistence or queue adapter. */
export class BridgeInfrastructureError extends Error {
  readonly _tag = "BridgeInfrastructureError" as const;
  override readonly name = "BridgeInfrastructureError";
  readonly operation: string;
  readonly retryable: boolean;
  override readonly cause: unknown;

  constructor(operation: string, cause: unknown, retryable = false) {
    super(`Bridge infrastructure operation failed: ${operation}`);
    this.operation = operation;
    this.cause = cause;
    this.retryable = retryable;
  }
}
