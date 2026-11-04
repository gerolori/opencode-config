/**
 * Core ntfy notifier.
 *
 * Consumes 2.x plugin events and decides whether to publish a phone
 * notification. It is deliberately decoupled from the OpenCode SDK and from the
 * network so it can be exercised hermetically with a fake event stream.
 *
 * Behaviour:
 * - only the supplied event types are understood; anything else is ignored;
 * - `session.created.parentID` marks a child (subagent) session, and success,
 *   error, and permission events from children are suppressed to avoid
 *   notification storms;
 * - every event is deduplicated by its unique `id`, so a redelivered event never
 *   produces a second notification;
 * - notification bodies contain no session title, prompt, message, resource
 *   path, command text, error text, or permission action: only fixed strings.
 *   `session.execution.failed` carries a structured `error` object, and
 *   `permission.asked` carries an `action` and `resources`; none of those
 *   payloads is ever read;
 * - publishing is fire-and-forget; a rejection is routed to `onError` (default:
 *   ignored) and never thrown into the event loop.
 * - when a `clickForSession` builder is supplied (from an opt-in
 *   `OPENCODE_WEB_URL`), root notifications also carry an ntfy `Click` URL for
 *   the exact session. A missing, unsafe, or throwing builder omits the link;
 *   notification delivery is unaffected.
 */

import type { NtfyPriority } from "./publisher";

export interface NtfyNotification {
  readonly title: string;
  readonly message: string;
  readonly priority: NtfyPriority;
  readonly tags: readonly string[];
  /** Optional ntfy `Click` header; only a configured web root ever supplies it. */
  readonly click?: string;
}

export type NtfySend = (notification: NtfyNotification) => Promise<void>;

/**
 * Invoke an error sink without letting a throwing sink escape as an unhandled
 * rejection. A diagnostic callback must never break the notification path.
 */
export function safeOnError(
  onError: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
  if (onError === undefined) return;
  try {
    onError(error);
  } catch {
    // Deliberately swallowed.
  }
}

export interface NtfyNotifierOptions {
  readonly send: NtfySend;
  readonly onError?: (error: unknown) => void;
  /** Dedup/child-set capacity; oldest entries are evicted first. */
  readonly maxTracked?: number;
  /**
   * Optional click-link builder. It is called only for a root notification and
   * must return a fully safe URL or `undefined`. A throw is contained.
   */
  readonly clickForSession?: (sessionID: string) => string | undefined;
}

export interface NtfyNotifier {
  handle(event: unknown): void;
  seedChildren(sessionIDs: Iterable<string>): void;
}

export type ParsedNtfyEvent =
  | { readonly kind: "created"; readonly id: string; readonly sessionID: string; readonly parentID?: string }
  | { readonly kind: "success"; readonly id: string; readonly sessionID: string }
  | { readonly kind: "error"; readonly id: string; readonly sessionID: string }
  | { readonly kind: "permission"; readonly id: string; readonly sessionID: string };

const DEFAULT_MAX_TRACKED = 4096;

/** Insertion-ordered set with a fixed capacity; the oldest value is evicted. */
class BoundedSet {
  private readonly values = new Set<string>();

  constructor(private readonly limit: number) {}

  add(value: string): boolean {
    if (this.values.has(value)) return false;
    this.values.add(value);
    if (this.values.size > this.limit) {
      const oldest = this.values.values().next().value;
      if (typeof oldest === "string") this.values.delete(oldest);
    }
    return true;
  }

  has(value: string): boolean {
    return this.values.has(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Narrow an untrusted event into the small shape the notifier needs. Returns
 * `undefined` for anything malformed or of an unsubscribed type.
 */
export function parseNtfyEvent(event: unknown): ParsedNtfyEvent | undefined {
  const envelope = asRecord(event);
  if (envelope === undefined) return undefined;

  const id = asString(envelope.id);
  const type = asString(envelope.type);
  const data = asRecord(envelope.data);
  if (id === undefined || type === undefined || data === undefined) return undefined;

  const sessionID = asString(data.sessionID);
  if (sessionID === undefined || sessionID === "") return undefined;

  if (type === "session.created") {
    const parentID = asString(data.parentID);
    return { kind: "created", id, sessionID, parentID };
  }
  if (type === "session.execution.succeeded") {
    return { kind: "success", id, sessionID };
  }
  if (type === "session.execution.failed") {
    return { kind: "error", id, sessionID };
  }
  if (type === "permission.asked") {
    return { kind: "permission", id, sessionID };
  }
  return undefined;
}

export function createNtfyNotifier(options: NtfyNotifierOptions): NtfyNotifier {
  const maxTracked = options.maxTracked ?? DEFAULT_MAX_TRACKED;
  const seen = new BoundedSet(maxTracked);
  const children = new BoundedSet(maxTracked);

  const emit = (notification: NtfyNotification): void => {
    void Promise.resolve()
      .then(() => options.send(notification))
      .catch((error: unknown) => {
        safeOnError(options.onError, error);
      });
  };

  /**
   * Attach a click link when a builder is configured. A builder throw or an
   * unsafe session id simply omits the link; it never breaks the notification.
   */
  const withClick = (
    notification: NtfyNotification,
    sessionID: string,
  ): NtfyNotification => {
    const clickForSession = options.clickForSession;
    if (clickForSession === undefined) return notification;
    let click: string | undefined;
    try {
      click = clickForSession(sessionID);
    } catch {
      return notification;
    }
    return click === undefined ? notification : { ...notification, click };
  };

  return {
    handle(event: unknown): void {
      const parsed = parseNtfyEvent(event);
      if (parsed === undefined) return;
      if (!seen.add(parsed.id)) return;

      if (parsed.kind === "created") {
        if (parsed.parentID !== undefined && parsed.parentID !== "") {
          children.add(parsed.sessionID);
        }
        return;
      }

      if (children.has(parsed.sessionID)) return;

      if (parsed.kind === "success") {
        emit(
          withClick(
            {
              title: "OpenCode",
              message: "Session complete",
              priority: "default",
              tags: ["white_check_mark"],
            },
            parsed.sessionID,
          ),
        );
        return;
      }

      if (parsed.kind === "error") {
        emit(
          withClick(
            {
              title: "OpenCode",
              message: "Session error",
              priority: "high",
              tags: ["rotating_light"],
            },
            parsed.sessionID,
          ),
        );
        return;
      }

      emit(
        withClick(
          {
            title: "OpenCode",
            message: "Permission needed",
            priority: "high",
            tags: ["warning"],
          },
          parsed.sessionID,
        ),
      );
    },

    seedChildren(sessionIDs: Iterable<string>): void {
      for (const sessionID of sessionIDs) {
        if (typeof sessionID === "string" && sessionID !== "") children.add(sessionID);
      }
    },
  };
}
