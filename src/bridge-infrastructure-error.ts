/**
 * Typed failure raised by persistence or queue infrastructure.
 * `retryable` controls whether the queue should make another delivery attempt;
 * `cause` retains the original failure for internal diagnostics.
 */
export class BridgeInfrastructureError extends Error {
  readonly _tag = "BridgeInfrastructureError" as const;
  override readonly name = "BridgeInfrastructureError";
  readonly operation: string;
  readonly retryable: boolean;
  override readonly cause: unknown;

  /** Create a sanitized infrastructure error associated with one operation. */
  constructor(operation: string, cause: unknown, retryable = false) {
    super(`Bridge infrastructure operation failed: ${operation}`);
    this.operation = operation;
    this.cause = cause;
    this.retryable = retryable;
  }
}
