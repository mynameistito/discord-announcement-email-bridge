import { Effect } from "effect";

import type { PollingPorts } from "@/application/polling";
import { classifyMessages } from "@/application/polling-classification";
import { persistAndEnqueue } from "@/application/polling-deliveries";
import { fetchHistory, initializeCursor } from "@/application/polling-history";
import type { Subscription } from "@/domain";

export const pollSubscription = (
  ports: PollingPorts,
  subscription: Subscription
) =>
  Effect.gen(function* pollSubscriptionEffect() {
    const cursor = yield* ports.repository.cursor(subscription.id);
    if (cursor === undefined) {
      yield* initializeCursor(
        ports,
        subscription.id,
        subscription.destinationChannelId
      );
      return;
    }
    const history = yield* fetchHistory(
      ports,
      subscription.destinationChannelId,
      cursor
    );
    const announcements = yield* classifyMessages(
      ports,
      subscription,
      history.messages
    );
    yield* persistAndEnqueue(
      ports,
      subscription,
      announcements,
      history.highWater
    );
  });
