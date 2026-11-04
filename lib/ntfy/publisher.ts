/**
 * NTFY HTTP publisher.
 *
 * Builds the ntfy HTTP publish request (`POST <topic-url>`, message in the
 * body, metadata in headers) behind a narrow injectable interface so tests can
 * supply a fake fetch and the core notifier never sees the endpoint or token.
 *
 * The endpoint URL and token live only inside the publisher closure. Every
 * failure mode is collapsed to a generic error that never includes the URL,
 * token, response body, or status text; a transport exception is sanitized even
 * when the underlying fetch error mentions the endpoint.
 */

export type NtfyPriority = "default" | "high";

export interface NtfyPublishRequest {
  readonly url: string;
  readonly token?: string;
  readonly title: string;
  readonly message: string;
  readonly priority: NtfyPriority;
  readonly tags: readonly string[];
}

/** Minimal fetch contract; the real `fetch` satisfies it. */
export type NtfyFetch = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{ readonly ok?: boolean }>;

export type NtfyPublisher = (request: NtfyPublishRequest) => Promise<void>;

export const DEFAULT_PUBLISH_TIMEOUT_MS = 5000;

export interface NtfyPublisherOptions {
  readonly timeoutMs?: number;
  /**
   * Lifecycle signal. When it aborts (for example on plugin cleanup or when a
   * newer start supersedes this one), any in-flight publish is aborted too.
   */
  readonly signal?: AbortSignal;
}

/**
 * Wrap a fetch implementation. The returned publisher rejects with a generic,
 * URL-free error on transport failure, timeout, lifecycle abort, or an explicit
 * non-2xx (`ok === false`) response. Callers treat rejection as nonfatal.
 */
export function createFetchPublisher(
  fetchImpl: NtfyFetch,
  options: NtfyPublisherOptions = {},
): NtfyPublisher {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  const lifecycle = options.signal;
  return async (request) => {
    if (lifecycle?.aborted === true) {
      // Already torn down: do not start a new publish.
      throw new Error("ntfy publish failed");
    }

    const controller = new AbortController();
    const onLifecycleAbort = () => controller.abort();
    lifecycle?.addEventListener("abort", onLifecycleAbort);

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }

    const headers: Record<string, string> = {
      Title: request.title,
      Priority: request.priority,
      Tags: request.tags.join(","),
    };
    if (request.token !== undefined) {
      headers.Authorization = `Bearer ${request.token}`;
    }

    let response: { readonly ok?: boolean } | undefined;
    try {
      response = await fetchImpl(request.url, {
        method: "POST",
        headers,
        body: request.message,
        signal: controller.signal,
      });
    } catch {
      // A transport exception (including the timeout or lifecycle abort) can
      // carry the URL, host, or other details in its message. Collapse it to a
      // generic, URL-free error so nothing sensitive can be logged or surfaced.
      throw new Error("ntfy publish failed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      lifecycle?.removeEventListener("abort", onLifecycleAbort);
    }

    if (response?.ok === false) {
      throw new Error("ntfy publish was rejected");
    }
  };
}
