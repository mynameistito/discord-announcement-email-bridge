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

export interface E2EOptions {
  readonly config: E2EConfig;
  readonly workerUrl?: string;
  readonly remote?: boolean;
  readonly profile?: string;
  readonly signal: AbortSignal;
  readonly log?: (message: string, tone?: LogTone) => void;
  readonly attachment?: AnnouncementAttachment;
}

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

export type LogTone = "info" | "success" | "warning" | "failure";

export interface WorkerStatus {
  readonly sentDeliveries: number;
  readonly failedDeliveries: number;
  readonly targetSentDeliveries?: number;
  readonly targetFailedDeliveries?: number;
}

export const announcementContent = (marker: string): string =>
  `**E2E announcement** ${marker}\n*Testing Discord Markdown rendering.*\n\n- First checklist item\n- Second checklist item\n\nInline code: \`const e2e = true\`\n[Discord API](https://discord.com/developers/docs/intro)`;
