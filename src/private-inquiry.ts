/**
 * Private inquiry runtime — shared execution module for Pi extensions.
 *
 * Owns the mechanism only: full fork from a frozen qualified source, guarded
 * result file, same-child bounded correction, exact-child cancellation and
 * typed failures. The execution core is Continue's accepted private-decision
 * operation, moved verbatim into ./private-inquiry/core.ts. Scheduling,
 * verdict schemas, review policy, counters and publication stay with the
 * consumer.
 *
 * The pinned private pi-subagents runtime is imported lazily by
 * `createPrivateRuntime()`, so importing this subpath never initializes Pi.
 */

import type { WatchdogRuntime } from "private-inquiry-subagents-runtime/watchdog-runtime";

export {
	INVALID_ATTEMPT_LIMIT,
	RESULT_DIR_PREFIX,
	RESULT_FILE_NAME,
	RESULT_FILE_TAG,
	runPrivateDecision as runPrivateInquiry,
	type PayloadValidation,
	type PrivateDecisionObservation as PrivateInquiryObservation,
	type PrivateDecisionOptions as PrivateInquiryOptions,
	type PrivateDecisionResult as PrivateInquiryResult,
	type ResultFileNaming,
} from "./private-inquiry/core.js";

export type {
	ChildRetryPolicy as RetryPolicy,
	WatchdogChildSession as PrivateChildSession,
	WatchdogExecutionProfile as ExecutionProfile,
	WatchdogForkInput as PrivateForkInput,
	WatchdogRuntime as PrivateRuntime,
} from "private-inquiry-subagents-runtime/watchdog-runtime";

/**
 * Create one private runtime: the only call that loads the pinned private
 * pi-subagents entry (and therefore Pi). Dispose it when the owner unloads.
 * Works only where the host transpiles TypeScript under node_modules (tsx,
 * Bun, Deno). Pi extensions import the runtime subpath from their own source.
 */
export async function createPrivateRuntime(): Promise<WatchdogRuntime> {
	const mod = await import("private-inquiry-subagents-runtime/watchdog-runtime");
	return mod.createWatchdogRuntime();
}

// ---------------------------------------------------------------------------
// Frozen qualified source (design D2)
// ---------------------------------------------------------------------------

/** Typed setup failure carrying a stable reason. */
export class PrivateInquirySetupError extends Error {
	constructor(
		message: string,
		readonly reason: "no-replayable-anchor",
	) {
		super(message);
		this.name = "PrivateInquirySetupError";
	}
}

/** A session entry shape sufficient for replayability analysis. */
export interface ReplayableEntry {
	readonly id: string;
	readonly parentId: string | null;
	readonly type: string;
	readonly message?:
		| {
				readonly role?: string;
				readonly stopReason?: string;
				readonly content?: readonly {
					readonly type: string;
					readonly id?: string;
					readonly toolCallId?: string;
				}[];
		  }
		| undefined;
}

/** Structural parent-session surface needed to capture a frozen source. */
export interface PrivateInquiryParentSession {
	getLeafId(): string | null;
	getEntries(): readonly unknown[];
}

function answeredToolCallIds(entries: readonly ReplayableEntry[]): Set<string> {
	const answered = new Set<string>();
	for (const entry of entries) {
		const message = entry.message as
			| (ReplayableEntry["message"] & { readonly toolCallId?: unknown })
			| undefined;
		if (message?.role !== "toolResult") continue;
		// Pi persists a tool result as one message carrying its toolCallId.
		if (typeof message.toolCallId === "string") answered.add(message.toolCallId);
		for (const block of message.content ?? []) {
			if (typeof block.toolCallId === "string") answered.add(block.toolCallId);
		}
	}
	return answered;
}

/**
 * Whether a persisted entry is a safe fork anchor. An assistant entry whose
 * tool batch is not fully answered is an open batch: not replayable.
 */
export function isReplayableEntry(
	entries: readonly ReplayableEntry[],
	entry: ReplayableEntry,
): boolean {
	if (entry.message?.role !== "assistant") return true;
	if (entry.message.stopReason !== "toolUse") return true;
	const calls = (entry.message.content ?? [])
		.filter((block) => block.type === "toolCall" && typeof block.id === "string")
		.map((block) => block.id as string);
	if (calls.length === 0) return true;
	const answered = answeredToolCallIds(entries);
	return calls.every((id) => answered.has(id));
}

/**
 * Latest replayable persisted entry, walking back from `leafId` past an open
 * tool batch. Returns undefined when no persisted entry is replayable.
 */
export function latestReplayableAnchor(
	entries: readonly ReplayableEntry[],
	leafId: string | null,
): string | undefined {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	let current = leafId ? byId.get(leafId) : undefined;
	while (current) {
		if (isReplayableEntry(entries, current)) return current.id;
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return undefined;
}

/**
 * Capture the fork anchor at trigger time: the latest replayable entry, or
 * a validated explicit anchor. Pass the result as `fork.anchorId`. No
 * replayable source is a typed setup failure — never a wait, abort or
 * fresh-context fallback.
 */
export function captureAnchor(
	parent: PrivateInquiryParentSession,
	anchorId?: string,
): string {
	const entries = parent.getEntries() as readonly ReplayableEntry[];
	const id = anchorId ?? latestReplayableAnchor(entries, parent.getLeafId());
	const anchor = id === undefined ? undefined : entries.find((entry) => entry.id === id);
	if (id === undefined || anchor === undefined || !isReplayableEntry(entries, anchor)) {
		throw new PrivateInquirySetupError(
			"the parent has no replayable persisted entry to fork from",
			"no-replayable-anchor",
		);
	}
	return id;
}
