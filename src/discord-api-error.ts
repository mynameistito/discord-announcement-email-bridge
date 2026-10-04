/** A retryable Discord REST or payload failure. */
export class DiscordApiError extends Error {
  readonly _tag = "DiscordApiError" as const;
  override readonly name = "DiscordApiError";
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}
