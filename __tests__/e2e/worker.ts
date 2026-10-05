import {
  CloudflareAccessRedirectError,
  isCloudflareAccessRedirect,
  jsonRequest,
  request,
  waitUntil,
} from "@tests/e2e/http.ts";
import type { E2EConfig, LogTone, WorkerStatus } from "@tests/e2e/types.ts";

type Log = (message: string, tone?: LogTone) => void;

/**
 * Remove trailing slashes from a Worker base URL.
 * @param value - Configured Worker URL.
 * @returns URL without trailing slash characters.
 */
export const normalizedWorkerUrl = (value: string): string => {
  let normalized = value;
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
};

/**
 * Create authorization headers for bridge admin requests.
 * @param config - E2E credentials.
 * @returns Headers containing the admin bearer token and optional Access token.
 */
const adminHeaders = (config: E2EConfig): Headers => {
  const headers = new Headers({ Authorization: `Bearer ${config.adminToken}` });
  if (config.accessClientId && config.accessClientSecret) {
    headers.set("CF-Access-Client-Id", config.accessClientId);
    headers.set("CF-Access-Client-Secret", config.accessClientSecret);
  }
  return headers;
};

/**
 * Wait for the configured Worker to respond successfully to its health check.
 * @param workerUrl - Base URL of the Worker.
 * @param config - E2E credentials and Access service token.
 * @param signal - Workflow cancellation signal.
 * @returns Promise resolved when the Worker is healthy.
 */
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
        if (isCloudflareAccessRedirect(response)) {
          throw new CloudflareAccessRedirectError("Worker health check");
        }
        return response.ok;
      } catch (error) {
        if (signal.aborted || error instanceof CloudflareAccessRedirectError) {
          throw error;
        }
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
  if (isCloudflareAccessRedirect(response)) {
    throw new CloudflareAccessRedirectError(label);
  }
  if (response.status !== 202) {
    throw new Error(`${label} failed (HTTP ${response.status})`);
  }
};

/**
 * Poll once to establish a baseline cursor before creating the test post.
 * @param url - Base URL of the Worker.
 * @param config - E2E credentials.
 * @param signal - Workflow cancellation signal.
 * @returns Promise resolved when the poll is accepted.
 */
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

/**
 * Poll the bridge after the test crosspost has been created.
 * @param url - Base URL of the Worker.
 * @param config - E2E credentials.
 * @param signal - Workflow cancellation signal.
 * @returns Promise resolved when the poll is accepted.
 */
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

/**
 * Read and validate delivery counters for one Discord message.
 * @param url - Base URL of the Worker.
 * @param headers - Bridge admin authorization headers.
 * @param messageId - Discord source message identifier.
 * @param signal - Workflow cancellation signal.
 * @returns Delivery state for the requested message.
 */
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

/**
 * Wait until the bridge records a successful email delivery.
 * @param url - Base URL of the Worker.
 * @param config - E2E credentials.
 * @param messageId - Discord follower-copy identifier.
 * @param signal - Workflow cancellation signal.
 * @param log - Progress logger.
 * @returns Promise resolved when delivery succeeds.
 */
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
      if ((status.targetFailedDeliveries ?? 0) > 0) {
        throw new Error("Worker recorded a failed email delivery");
      }
      return status;
    },
    (status) => (status.targetSentDeliveries ?? 0) > 0,
    5000,
    180_000,
    "Worker did not record a successful email delivery within 180 seconds",
    signal
  );
};
