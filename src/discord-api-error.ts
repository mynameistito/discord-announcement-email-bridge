/**
 * Sanitized Discord REST or payload failure with explicit HTTP status and
 * retry classification for the queue consumer.
 */
export class DiscordApiError extends Error {
  readonly _tag = "DiscordApiError" as const;
  override readonly name = "DiscordApiError";
  readonly status: number;
  readonly retryable: boolean;

  /** Create a Discord failure with a safe message and retry decision. */
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}
