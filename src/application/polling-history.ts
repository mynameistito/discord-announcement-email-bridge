import { Effect, Schema } from "effect";

import type {
  PollingPorts,
  UnparsedDiscordMessage,
} from "@/application/polling";
import { DiscordApiError } from "@/discord-api-error";
import {
  MessageSchema,
  compareSnowflakes,
  hasCrosspostFlag,
  oldestFirst,
} from "@/domain";
import type { DiscordMessage } from "@/domain";

/** Minimal payload validator used to advance cursors across malformed messages. */
const MessageIdSchema = Schema.Struct({ id: Schema.String });
/** Candidate validator for identifying malformed crossposts that must block a cursor. */
const PotentialCrosspostSchema = Schema.Struct({
  flags: Schema.Number,
  webhook_id: Schema.optional(Schema.String),
});

/** Discriminated result separating usable messages from malformed or irrelevant rows. */
type DecodedPolledMessage =
  | {
      readonly _tag: "Message";
      readonly id: string;
      readonly message: DiscordMessage;
    }
  | {
      readonly _tag: "MalformedCrosspost";
      readonly id?: string;
      readonly error: DiscordApiError;
    }
  | { readonly _tag: "Skip"; readonly id?: string };

/**
 * Set a new subscription cursor to the latest valid message ID without
 * delivering historical announcements from before initial setup.
 */
export const initializeCursor = (
  ports: PollingPorts,
  subscriptionId: string,
  channelId: string
) =>
  Effect.gen(function* initializeCursorEffect() {
    const latest = yield* ports.source.fetchLatest(channelId);
    const ids = latest.flatMap((payload) => {
      const parsed = Schema.decodeUnknownOption(MessageIdSchema)(payload.raw);
      return parsed._tag === "Some" && /^\d+$/u.test(parsed.value.id)
        ? [parsed.value.id]
        : [];
    });
    yield* ports.repository.initializeCursor(
      subscriptionId,
      ids.toSorted(compareSnowflakes).at(-1) ?? "0"
    );
  });

/** Decode one raw Discord payload and retain IDs for safe cursor progression. */
const decodePolledMessage = (
  payload: UnparsedDiscordMessage
): DecodedPolledMessage => {
  const parsedId = Schema.decodeUnknownOption(MessageIdSchema)(payload.raw);
  const id =
    parsedId._tag === "Some" && /^\d+$/u.test(parsedId.value.id)
      ? parsedId.value.id
      : undefined;
  const message = Schema.decodeUnknownOption(MessageSchema)(payload.raw);
  if (message._tag === "Some") {
    return { _tag: "Message", id: message.value.id, message: message.value };
  }
  const possibleCrosspost = Schema.decodeUnknownOption(
    PotentialCrosspostSchema
  )(payload.raw);
  if (
    possibleCrosspost._tag === "Some" &&
    hasCrosspostFlag(possibleCrosspost.value.flags)
  ) {
    return {
      _tag: "MalformedCrosspost",
      ...(id ? { id } : undefined),
      error: new DiscordApiError(
        "Discord returned a malformed crosspost candidate",
        502,
        false
      ),
    };
  }
  return { _tag: "Skip", ...(id ? { id } : undefined) };
};

/**
 * Read backward-paginated history newer than a cursor, fail closed on malformed
 * candidate crossposts, and return messages plus the greatest observed ID.
 */
export const fetchHistory = (
  ports: PollingPorts,
  channelId: string,
  cursor: string
) =>
  Effect.gen(function* fetchHistoryEffect() {
    let highWater = cursor;
    const messages: DiscordMessage[] = [];
    let page = yield* ports.source.fetchAfter(channelId, cursor);
    for (;;) {
      const pageMessages: DiscordMessage[] = [];
      for (const payload of page) {
        const decoded = decodePolledMessage(payload);
        if (decoded.id && compareSnowflakes(decoded.id, highWater) > 0) {
          highWater = decoded.id;
        }
        if (
          decoded._tag === "MalformedCrosspost" &&
          (!decoded.id || compareSnowflakes(decoded.id, cursor) > 0)
        ) {
          return yield* Effect.fail(decoded.error);
        }
        if (decoded._tag === "Message") {
          pageMessages.push(decoded.message);
        }
      }
      messages.push(
        ...pageMessages.filter(
          (message) => compareSnowflakes(message.id, cursor) > 0
        )
      );
      const ids = page
        .flatMap((payload) => {
          const parsed = Schema.decodeUnknownOption(MessageIdSchema)(
            payload.raw
          );
          return parsed._tag === "Some" && /^\d+$/u.test(parsed.value.id)
            ? [parsed.value.id]
            : [];
        })
        .toSorted(compareSnowflakes);
      const [oldest] = ids;
      if (
        !oldest ||
        page.length < 100 ||
        compareSnowflakes(oldest, cursor) <= 0
      ) {
        break;
      }
      page = yield* ports.source.fetchBefore(channelId, oldest);
    }
    return { highWater, messages: oldestFirst(messages) };
  });
