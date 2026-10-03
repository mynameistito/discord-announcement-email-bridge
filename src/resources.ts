import * as Cloudflare from "alchemy/Cloudflare";

/** Queue for asynchronous, at-least-once email delivery. */
export const DeliveryQueue = Cloudflare.Queues.Queue("DeliveryQueue");

/** Dead-letter queue for delivery messages that exhaust platform retries. */
export const DeliveryDeadLetterQueue = Cloudflare.Queues.Queue(
  "DeliveryDeadLetterQueue"
);
