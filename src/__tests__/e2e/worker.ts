import {
  CloudflareAccessRedirectError,
  isCloudflareAccessRedirect,
  jsonRequest,
  request,
  waitUntil,
} from "./http.ts";
import type { E2EConfig, LogTone, WorkerStatus } from "./types.ts";

type Log = (message: string, tone?: LogTone) => void;

export const normalizedWorkerUrl = (value: string): string =>
  value.replace(/\/+$/u, "");

export const adminHeaders = (config: E2EConfig): Headers => {
  const headers = new Headers({ Authorization: `Bearer ${config.adminToken}` });
  if (config.accessClientId && config.accessClientSecret) {
    headers.set("CF-Access-Client-Id", config.accessClientId);
    headers.set("CF-Access-Client-Secret", config.accessClientSecret);
  }
  return headers;
};

export const waitForWorkerReady = async (
  workerUrl: string,
  config: E2EConfig,
  signal: AbortSignal
): Promise<void> => {
  const base = normalizedWorkerUrl(workerUrl);
  const headers = new Headers();
  if (config.accessClientId && config.accessClientSecret) {
    headers.set("CF-Access-Client-Id", config.accessClientId);
    headers.set("CF-Access-Client-Secret", config.accessClientSecret);
  }
  await waitUntil(
    async (probeSignal) => {
      try {
        const response = await request(
          `${base}/healthz`,
          { headers, redirect: "manual", signal: probeSignal },
          signal
        );
        if (isCloudflareAccessRedirect(response))
          throw new CloudflareAccessRedirectError("Worker health check");
        return response.ok;
      } catch (error) {
        if (signal.aborted || error instanceof CloudflareAccessRedirectError)
          throw error;
        return false;
      }
    },
    Boolean,
    1000,
    60_000,
    "Worker did not become healthy within 60 seconds",
    signal
  );
};

const checkPoll = async (
  url: string,
  headers: Headers,
  label: string,
  signal: AbortSignal
): Promise<void> => {
  const response = await request(
    `${url}/admin/poll`,
    { headers, method: "POST", redirect: "manual" },
    signal
  );
  if (isCloudflareAccessRedirect(response))
    throw new CloudflareAccessRedirectError(label);
  if (response.status !== 202)
    throw new Error(`${label} failed (HTTP ${response.status})`);
};

export const seedCursor = (
  url: string,
  config: E2EConfig,
  signal: AbortSignal
): Promise<void> =>
  checkPoll(
    normalizedWorkerUrl(url),
    adminHeaders(config),
    "Baseline Worker poll",
    signal
  );

export const pollBridge = (
  url: string,
  config: E2EConfig,
  signal: AbortSignal
): Promise<void> =>
  checkPoll(
    normalizedWorkerUrl(url),
    adminHeaders(config),
    "Worker poll",
    signal
  );

const deliveryStatus = async (
  url: string,
  headers: Headers,
  messageId: string,
  signal: AbortSignal
): Promise<WorkerStatus> => {
  const statusUrl = new URL(`${url}/admin/status`);
  statusUrl.searchParams.set("discordMessageId", messageId);
  const status = await jsonRequest<WorkerStatus>(
    statusUrl.toString(),
    { headers, redirect: "manual", signal },
    "Read Worker delivery status",
    signal
  );
  if (
    !Number.isSafeInteger(status.sentDeliveries) ||
    !Number.isSafeInteger(status.failedDeliveries)
  ) {
    throw new TypeError(
      "Worker status response contains invalid delivery counts"
    );
  }
  return status;
};

export const waitForDelivery = async (
  url: string,
  config: E2EConfig,
  messageId: string,
  signal: AbortSignal,
  log: Log
): Promise<void> => {
  const base = normalizedWorkerUrl(url);
  const headers = adminHeaders(config);
  log("Poll accepted; waiting for the queued email delivery...");
  await waitUntil(
    async (probeSignal) => {
      const status = await deliveryStatus(
        base,
        headers,
        messageId,
        probeSignal
      );
      if ((status.targetFailedDeliveries ?? 0) > 0)
        throw new Error("Worker recorded a failed email delivery");
      return status;
    },
    (status) => (status.targetSentDeliveries ?? 0) > 0,
    5000,
    180_000,
    "Worker did not record a successful email delivery within 180 seconds",
    signal
  );
};
