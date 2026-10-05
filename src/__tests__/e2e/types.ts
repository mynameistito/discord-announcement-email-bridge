/** Required credentials and destination identifiers for an E2E run. */
export interface E2EConfig {
  readonly token: string;
  readonly guildId: string;
  readonly sourceChannelId: string;
  readonly receiverChannelId: string;
  readonly recipient: string;
  readonly resendKey: string;
  readonly senderName: string;
  readonly senderEmail: string;
  readonly adminToken: string;
  readonly accessClientId?: string;
  readonly accessClientSecret?: string;
}

/** Options controlling a local or remote E2E workflow. */
export interface E2EOptions {
  readonly config: E2EConfig;
  readonly workerUrl?: string;
  readonly remote?: boolean;
  readonly profile?: string;
  readonly signal: AbortSignal;
  readonly log?: (message: string, tone?: LogTone) => void;
  readonly attachment?: AnnouncementAttachment;
}

/** File or in-memory image attachment uploaded with the test announcement. */
export type AnnouncementAttachment =
  | {
      readonly kind: "bytes";
      readonly filename: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "path";
      readonly path: string;
      readonly filename?: string;
    };

/** Tone used to color E2E progress output. */
export type LogTone = "info" | "success" | "warning" | "failure";

/** Delivery counters returned by the bridge admin endpoint. */
export interface WorkerStatus {
  readonly sentDeliveries: number;
  readonly failedDeliveries: number;
  readonly targetSentDeliveries?: number;
  readonly targetFailedDeliveries?: number;
}

/**
 * Build test announcement text that exercises supported Discord Markdown.
 * @param marker - Unique text used to identify this test announcement.
 * @returns Message content containing Markdown examples.
 */
export const announcementContent = (marker: string): string =>
  `**E2E announcement** ${marker}\n*Testing Discord Markdown rendering.*\n\n- First checklist item\n- Second checklist item\n\nInline code: \`const e2e = true\`\n[Discord API](https://discord.com/developers/docs/intro)`;
