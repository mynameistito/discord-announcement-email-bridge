import { Queues } from "alchemy/Cloudflare";

/** Provision the asynchronous queue carrying durable email delivery IDs. */
export const DeliveryQueue = Queues.Queue("DeliveryQueue");

/** Provision the queue that receives delivery messages after platform retries. */
export const DeliveryDeadLetterQueue = Queues.Queue("DeliveryDeadLetterQueue");
