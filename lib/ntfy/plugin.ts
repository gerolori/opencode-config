/**
 * NTFY notification plugin glue for OpenCode 2.2.5.
 *
 * Reads the opt-in configuration from the service environment, subscribes to a
 * small set of documented session events, and forwards decisions to the core
 * notifier. It does not read sessions, prompts, or messages, and it never logs
 * the endpoint or token.
 *
 * Event choice (offline evidence: `@opencode/client` 2.2.5 `V2Event` union,
 * `@opencode/schema` `SessionEvent`/`SessionStatusEvent`, and the installed
 * 2.2.5 CLI runtime):
 * - `session.created` supplies `parentID`, which distinguishes a subagent child
 *   session from a root session.
 * - `session.execution.succeeded` is the terminal success event emitted by the
 *   2.2.5 runtime when a turn completes. Its `data` is only `{ sessionID }`.
 *   The legacy `session.idle` type still exists in the schema but the installed
 *   runtime does not publish it, so subscribing to it would miss completions.
 *   `session.status` is intentionally not subscribed to, so a completion cannot
 *   notify twice.
 * - `session.execution.failed` is the session-level execution failure event. Its
 *   `error` payload is not read. Interruptions, per-step failures, retries,
 *   compaction failures, and tool failures are deliberately NOT subscribed to,
 *   because they are transient or user-initiated and would create noise.
 * - `permission.asked` mirrors `context.permission` asks for root sessions; its
 *   `action`/`resources` are not read.
 *
 * Startup ordering: the event subscription is established *before* the bounded
 * child seed, and events are buffered (bounded) until the seed settles. This
 * avoids dropping root events that arrive during the seed while still letting
 * pre-existing child sessions be suppressed. If the buffer overflows, it is
 * flushed early and dispatch continues live (documented tradeoff).
 *
 * This is scaffolding proven against the installed type declarations, the
 * installed 2.2.5 runtime strings, and hermetic tests. Whether these events fire
 * at the expected time in a live service, whether `session.execution.failed`
 * fires for every failed turn, and how a child session's success is delivered
 * while its parent is still working, are NOT proven offline and require a live
 * restart check.
 *
 * Optional click-through links: when `OPENCODE_WEB_URL` is set, root
 * notifications carry an ntfy `Click` header built from that UI-canonical
 * origin and the event's `sessionID`. An absent or invalid value omits the link
 * and never disables notifications. The URL is never logged.
 */

import { resolveNtfyConfig } from "./config";
import {
  buildSessionClickUrl,
  OPENCODE_WEB_URL_ENV,
  resolveNtfyClickConfig,
} from "./click";
import { createNtfyNotifier, safeOnError, type NtfyNotifier } from "./notifier";
import { createFetchPublisher, type NtfyFetch } from "./publisher";

export const NTFY_EVENT_TYPES = [
  "session.created",
  "session.execution.succeeded",
  "session.execution.failed",
  "permission.asked",
] as const;
export type NtfyEventType = (typeof NTFY_EVENT_TYPES)[number];

/** Structural view of the parts of the 2.x plugin context this plugin uses. */
export interface NtfyPluginContext {
  readonly event: {
    subscribe: (options: {
      readonly types: readonly NtfyEventType[];
      readonly signal?: AbortSignal;
    }) => AsyncIterable<unknown>;
  };
  readonly session?: {
    list: () => Promise<{ readonly data: ReadonlyArray<{ readonly id: string; readonly parentID?: string }> }>;
  };
}

export interface NtfyPluginOverrides {
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: NtfyFetch;
  readonly onError?: (error: unknown) => void;
  /** Override the bounded child-seed timeout (tests use a small value). */
  readonly seedTimeoutMs?: number;
  /** Override the bounded startup event buffer (tests use a small value). */
  readonly maxBufferedEvents?: number;
}

/** Only one live subscription per process; a re-setup aborts the previous one. */
let activeController: AbortController | undefined;

/** Bound the startup child-seed so a hung `session.list()` cannot stall the plugin. */
export const NTFY_SEED_TIMEOUT_MS = 2000;

/** Bound the startup event buffer so a slow seed cannot grow memory without limit. */
export const NTFY_MAX_BUFFERED_EVENTS = 2048;

/** Abort and clear the single active subscription, if any. */
function stopActive(): void {
  const current = activeController;
  activeController = undefined;
  current?.abort();
}

/** Consume an event stream, forwarding each event to `handle`. Never throws. */
export async function consumeNtfyStream(
  stream: AsyncIterable<unknown>,
  handle: (event: unknown) => void,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    for await (const event of stream) {
      try {
        handle(event);
      } catch (error) {
        safeOnError(onError, error);
      }
    }
  } catch (error) {
    // A closed or aborted stream is expected during cleanup.
    safeOnError(onError, error);
  }
}

export interface NtfyEventPump {
  /** Flush buffered events in order and switch to live dispatch. */
  release(): void;
  /** True if the buffer overflowed and events were dispatched before release. */
  readonly overflowed: boolean;
  /** Resolves when the stream ends; never rejects. */
  readonly done: Promise<void>;
}

/**
 * Startup pump. Events are buffered (bounded) until `release()` so the child
 * seed can complete before any event is dispatched, without dropping events that
 * arrive during the seed. If the buffer overflows, it flushes early and
 * continues live; a pre-existing child not yet seeded could then notify once.
 */
export function pumpNtfyEvents(
  stream: AsyncIterable<unknown>,
  notifier: NtfyNotifier,
  onError?: (error: unknown) => void,
  maxBuffer: number = NTFY_MAX_BUFFERED_EVENTS,
): NtfyEventPump {
  const buffer: unknown[] = [];
  let buffering = true;
  let overflowed = false;

  const dispatch = (event: unknown): void => {
    notifier.handle(event);
  };

  const done = consumeNtfyStream(
    stream,
    (event) => {
      if (!buffering) {
        dispatch(event);
        return;
      }
      if (buffer.length < maxBuffer) {
        buffer.push(event);
        return;
      }
      // Buffer full: stop buffering, flush in order, then go live.
      buffering = false;
      overflowed = true;
      for (const buffered of buffer) dispatch(buffered);
      buffer.length = 0;
      dispatch(event);
    },
    onError,
  );

  return {
    release(): void {
      if (!buffering) return;
      buffering = false;
      for (const buffered of buffer) dispatch(buffered);
      buffer.length = 0;
    },
    get overflowed(): boolean {
      return overflowed;
    },
    done,
  };
}

/**
 * Start notifications. Returns a cleanup function when active, or `undefined`
 * when disabled. A disabled re-setup tears down any prior subscription.
 */
export async function startNtfyNotifications(
  context: NtfyPluginContext,
  overrides: NtfyPluginOverrides = {},
): Promise<(() => void) | void> {
  const resolution = resolveNtfyConfig(overrides.env ?? process.env);
  if (!resolution.enabled) {
    // A disabled re-setup must not leave a previous subscription running.
    stopActive();
    return undefined;
  }

  const fetchImpl = overrides.fetch ?? (globalThis.fetch as unknown as NtfyFetch | undefined);
  if (typeof fetchImpl !== "function") {
    stopActive();
    return undefined;
  }

  // Claim the single active slot *before* any `await` or I/O, so two
  // overlapping start calls cannot both go live. A later call aborts the
  // earlier controller here; the earlier call's subscription is torn down and
  // it returns without going live. The same signal aborts any in-flight publish
  // when this instance is torn down.
  const controller = new AbortController();
  const previous = activeController;
  activeController = controller;
  previous?.abort();

  const publish = createFetchPublisher(fetchImpl, { signal: controller.signal });
  const env = overrides.env ?? process.env;
  const clickConfig = resolveNtfyClickConfig(env[OPENCODE_WEB_URL_ENV]);
  const notifier = createNtfyNotifier({
    send: (notification) =>
      publish({
        url: resolution.config.url,
        token: resolution.config.token,
        ...notification,
      }),
    onError: overrides.onError,
    clickForSession:
      clickConfig === undefined
        ? undefined
        : (sessionID) => buildSessionClickUrl(clickConfig, sessionID),
  });

  // Subscribe BEFORE the seed so events that arrive during the seed are not
  // dropped. `subscribe` is synchronous and can throw; treat a throw as a
  // nonfatal disable and release the slot we claimed.
  let stream: AsyncIterable<unknown>;
  try {
    stream = context.event.subscribe({ types: NTFY_EVENT_TYPES, signal: controller.signal });
  } catch (error) {
    controller.abort();
    if (activeController === controller) activeController = undefined;
    safeOnError(overrides.onError, error);
    return undefined;
  }

  // Buffer events until the seed settles, preserving order and child
  // suppression without losing events that arrive during the seed.
  const pump = pumpNtfyEvents(
    stream,
    notifier,
    overrides.onError,
    overrides.maxBufferedEvents ?? NTFY_MAX_BUFFERED_EVENTS,
  );

  // Best-effort seed: a session created before this plugin loaded would
  // otherwise be unknown and could be mistaken for a root. It is bounded so a
  // hung or slow `session.list()` cannot stall the plugin. See the child-seed
  // race and pagination notes in docs/notifications.md.
  if (context.session !== undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seedTimeoutMs = overrides.seedTimeoutMs ?? NTFY_SEED_TIMEOUT_MS;
    try {
      const listed = await Promise.race([
        context.session.list(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("ntfy child-seed timed out")),
            seedTimeoutMs,
          );
        }),
      ]);
      if (activeController === controller) {
        notifier.seedChildren(
          listed.data
            .filter((session) => typeof session.parentID === "string" && session.parentID !== "")
            .map((session) => session.id),
        );
      }
    } catch {
      // Seeding is optional and bounded; continue with observation-only tracking.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // A newer start call superseded this one while seeding: do not go live.
  if (activeController !== controller) {
    controller.abort();
    return undefined;
  }

  pump.release();

  return () => {
    controller.abort();
    if (activeController === controller) activeController = undefined;
  };
}
