import { Queues } from "alchemy/Cloudflare";

/** Queue for asynchronous, at-least-once email delivery. */
export const DeliveryQueue = Queues.Queue("DeliveryQueue");

/** Dead-letter queue for delivery messages that exhaust platform retries. */
export const DeliveryDeadLetterQueue = Queues.Queue("DeliveryDeadLetterQueue");
