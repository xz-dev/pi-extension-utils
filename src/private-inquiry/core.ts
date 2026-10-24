import { type BigIntStats, constants } from "node:fs";
import {
	type FileHandle,
	access,
	lstat,
	mkdir,
	mkdtemp,
	open,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type {
	WatchdogChildSession,
	WatchdogForkInput,
	WatchdogRuntime,
} from "private-inquiry-subagents-runtime/watchdog-runtime";

/**
 * Host-side private inquiry operation — the proven private-decision core
 * (originally the design Decisions 4-7 adapter of
 * isolate-watchdog-decisions-in-private-fork), moved here verbatim and made
 * consumer-neutral.
 *
 * One logical inquiry = one private /var/tmp directory with a result file
 * initialized to `{}`, one child created through `WatchdogRuntime.fork`, and
 * up to two inquiry rounds in that same child (initial plus at most one
 * review-challenged reconsideration). Each round consumes at most
 * INVALID_ATTEMPT_LIMIT settled model responses; only normally settled
 * responses count as format attempts. Setup, file write/read, provider,
 * cancelled, and stale outcomes are typed failures, never format
 * corrections.
 *
 * The host owns policy and prompt wording via the `validate`, `prompt`,
 * `correction`, and `review` callbacks. This core appends the actual
 * JSON-encoded result path inside <private_inquiry_result_file>...</...> to
 * the callback text. No structured_output instructions are involved; the
 * file is the only result transport.
 */

/** Default marker element appended to every prompt carrying the actual result path. */
export const RESULT_FILE_TAG = "private_inquiry_result_file";

/** Default result filename inside the per-inquiry private directory. */
export const RESULT_FILE_NAME = "inquiry.json";

/**
 * Default mkdtemp prefix of the per-inquiry private directory: /var/tmp on
 * POSIX (disk-backed, unlike a RAM /tmp), the OS temp dir elsewhere.
 */
export const RESULT_DIR_PREFIX = join(
	process.platform === "win32" ? tmpdir() : "/var/tmp",
	"private-inquiry-",
);

/**
 * Consumer-visible result-file naming. Consumers that already published a
 * marker/file contract (Continue: watchdog_result_file, decision.json,
 * /var/tmp/watchdog-decision-) pass it here so adoption changes no literal.
 */
export interface ResultFileNaming {
	readonly tag?: string;
	readonly fileName?: string;
	readonly dirPrefix?: string;
}

/**
 * The fixed re-ask budget: consumed invalid responses per inquiry round.
 * Consumers may override per operation via `invalidAttemptLimit`.
 */
export const INVALID_ATTEMPT_LIMIT = 3;

/** Consumer-supplied payload validation result (design D3). */
export type PayloadValidation<T> =
	| { readonly valid: true; readonly value: T }
	| { readonly valid: false; readonly error: string };

/** Safe per-response observation handed to the optional audit callback. */
export interface PrivateDecisionObservation<T = unknown> {
	/** Which inquiry round produced this response. */
	readonly inquiry: "initial" | "reconsideration";
	/** 1-based consumed-response number inside this inquiry. */
	readonly attempt: number;
	readonly sessionId: string;
	readonly outcome:
		| { readonly kind: "valid"; readonly decision: T }
		| { readonly kind: "invalid"; readonly error: string };
}

/**
 * Truthful availability of the exact child's native session JSONL after
 * settlement. `available` carries the verified absolute path of a regular,
 * readable file; `unavailable` gives a bounded host-side reason instead of
 * an invented or unverified path. Retained evidence is diagnostic only —
 * never an execution or result authority.
 */
export type PrivateSessionEvidence =
	| {
			readonly kind: "available";
			/** Verified absolute path of the retained native session JSONL. */
			readonly path: string;
			readonly sessionId?: string;
	  }
	| {
			readonly kind: "unavailable";
			readonly reason:
				| "no-session"
				| "missing"
				| "not-regular-file"
				| "unreadable"
				| "not-absolute";
			readonly sessionId?: string;
	  };

/** Terminal result of one logical private inquiry. */
export type PrivateDecisionResult<T = unknown> =
	| {
			readonly kind: "decision";
			readonly decision: T;
			readonly sessionId: string;
			readonly session?: PrivateSessionEvidence;
			/** True when the decision came from the reconsideration inquiry. */
			readonly reconsidered: boolean;
	  }
	| {
			readonly kind: "decision-failed";
			readonly error: string;
			readonly sessionId: string;
			readonly session?: PrivateSessionEvidence;
			readonly reconsidered: boolean;
	  }
	| {
			readonly kind: "cancelled";
			readonly sessionId?: string;
			readonly session?: PrivateSessionEvidence;
	  }
	| {
			readonly kind: "execution-error";
			readonly error: string;
			readonly sessionId?: string;
			readonly session?: PrivateSessionEvidence;
	  };

export interface PrivateDecisionOptions<T = unknown> {
	readonly runtime: WatchdogRuntime;
	/** Fork input minus host-owned agentDir/resultFile, allocated here. */
	readonly fork: Omit<WatchdogForkInput, "agentDir" | "resultFile">;
	/** Consumed invalid responses allowed per inquiry round. Default 3. */
	readonly invalidAttemptLimit?: number;
	/** Result marker/file/directory naming; neutral defaults when omitted. */
	readonly naming?: ResultFileNaming;
	/** Cancellation signal for the whole logical inquiry. */
	readonly signal?: AbortSignal;
	/**
	 * Freshness guard evaluated before/after every awaited boundary and before
	 * the terminal result. False means stale: the child is cancelled and its
	 * outcome can never commit.
	 */
	readonly isCurrent: () => boolean;
	/**
	 * Consumer payload validation for the parsed result-file JSON object.
	 * A `{ valid: false }` with a safe diagnostic is one consumed invalid
	 * response, correctable in the same child.
	 */
	readonly validate: (payload: unknown) => PayloadValidation<T>;
	/**
	 * Inquiry prompt text. `definiteChallengeFeedback` is present only for the
	 * one reconsideration inquiry. The JSON-encoded result path in a
	 * <private_inquiry_result_file> marker is appended to the returned text.
	 */
	readonly prompt: (
		resultFile: string,
		definiteChallengeFeedback?: string,
	) => string;
	/**
	 * Correction text appended to the same child after a consumed invalid
	 * response; receives the safe validator diagnostic and result path. The
	 * result-file marker is appended to the returned text as for `prompt`.
	 */
	readonly correction: (error: string, resultFile: string) => string;
	/**
	 * Optional semantic review, invoked at most once and only for the valid
	 * initial candidate — never a replacement. Receives a copy of the flat
	 * candidate so observer mutation cannot alter the accepted result.
	 * Returning a string is a definite challenge whose feedback opens the one
	 * reconsideration inquiry; `undefined` releases the original candidate.
	 * Whether a candidate kind is reviewable at all is consumer policy,
	 * expressed by returning `undefined` from this callback.
	 */
	readonly review?: (decision: T) => Promise<string | undefined>;
	/**
	 * Optional safe per-response audit; receives a copy of the candidate.
	 * A throwing callback is swallowed: it must never add model requests or
	 * change decision accounting.
	 */
	readonly onResponse?: (observation: PrivateDecisionObservation<T>) => void;
	/**
	 * Optional lifecycle notification invoked once immediately before the
	 * first authorized prompt of each inquiry, after the child exists. A
	 * throwing callback is an execution error: no model request is launched
	 * silently afterwards.
	 */
	readonly onStarted?: (event: {
		readonly inquiry: "initial" | "reconsideration";
		readonly sessionId: string;
	}) => void;
}

type AttemptOutcome<T> =
	| { readonly kind: "valid"; readonly decision: T }
	| { readonly kind: "invalid"; readonly error: string }
	| { readonly kind: "cancelled" }
	| { readonly kind: "execution-error"; readonly error: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Prompt rejections caused by cancellation surface as AbortError. */
function isAbortError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { name?: unknown }).name === "AbortError"
	);
}

/**
 * Inspect the final assistant outcome this prompt appended to the child.
 * Only messages at or after `startIndex` — captured immediately before the
 * prompt — belong to this response; an inherited reply is never borrowed.
 * `none` means the settled prompt produced no own assistant message, so the
 * file (which may hold stale JSON) must not be evaluated as its result.
 * `failed` (`error`/`aborted`) is a typed provider outcome, never a format
 * correction.
 */
function assistantTerminalOutcome(
	child: WatchdogChildSession,
	startIndex: number,
):
	| { readonly kind: "none" }
	| { readonly kind: "ok" }
	| { readonly kind: "failed"; aborted: boolean; error: string } {
	for (let index = child.messages.length - 1; index >= startIndex; index--) {
		const message = child.messages[index];
		if (message?.role !== "assistant") continue;
		const stopReason = (message as { stopReason?: unknown }).stopReason;
		const detail = (message as { errorMessage?: unknown }).errorMessage;
		const errorText = typeof detail === "string" ? detail : undefined;
		if (stopReason === "aborted") {
			return {
				kind: "failed",
				aborted: true,
				error: errorText ?? "aborted",
			};
		}
		if (stopReason === "error") {
			return {
				kind: "failed",
				aborted: false,
				error: errorText ?? "provider error",
			};
		}
		return { kind: "ok" };
	}
	return { kind: "none" };
}

/**
 * Open the designated result file without following a final-component link
 * and pin the descriptor to the regular file the path named. POSIX adds
 * O_NOFOLLOW; Windows has no such flag, so on every platform the opened
 * descriptor must also match the link-free lstat identity (dev/ino). A
 * missing file is created only with O_CREAT|O_EXCL, which never follows a
 * link and fails if anything appeared in its place.
 */
async function openResultFile(
	path: string,
	flags: number,
	mode?: number,
): Promise<FileHandle> {
	let before: BigIntStats | undefined;
	try {
		before = await lstat(path, { bigint: true });
	} catch (error) {
		if (
			(flags & constants.O_CREAT) === 0 ||
			(error as NodeJS.ErrnoException).code !== "ENOENT"
		)
			throw error;
	}
	if (before !== undefined && !before.isFile())
		throw new Error("decision result path is not the designated regular file.");
	const handle = await open(
		path,
		flags |
			(constants.O_NOFOLLOW ?? 0) |
			(constants.O_NONBLOCK ?? 0) |
			(before === undefined ? constants.O_EXCL : 0),
		mode,
	);
	try {
		const after = await handle.stat({ bigint: true });
		if (
			!after.isFile() ||
			(before !== undefined &&
				(after.ino === 0n ||
					after.dev !== before.dev ||
					after.ino !== before.ino))
		)
			throw new Error(
				"decision result path is not the designated regular file.",
			);
		return handle;
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	}
}

/**
 * Evaluate the designated result file after a normally settled response.
 * Malformed JSON, non-object JSON, and validator-rejected payloads are
 * model-format errors. Symlink/non-regular targets and filesystem read
 * failures are host execution errors, never repaired here. One complete
 * JSON object is required; payload field semantics stay inside the
 * consumer-supplied `validate`.
 */
async function readResultFile<T>(
	resultFile: string,
	validate: (payload: unknown) => PayloadValidation<T>,
): Promise<
	| { readonly kind: "valid"; readonly decision: T }
	| { readonly kind: "invalid"; readonly error: string }
	| { readonly kind: "execution-error"; readonly error: string }
> {
	// Open without following links and fstat the descriptor: a replaced
	// directory, symlink, or other non-regular path is a host execution
	// failure, not a model-format retry.
	let raw: string;
	try {
		const handle = await openResultFile(resultFile, constants.O_RDONLY);
		try {
			raw = await handle.readFile("utf8");
		} finally {
			await handle.close().catch(() => {});
		}
	} catch (error) {
		return {
			kind: "execution-error",
			error: `result file unreadable: ${errorMessage(error)}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			kind: "invalid",
			error: "decision result file does not contain one complete JSON object.",
		};
	}
	const validation = validate(parsed);
	return validation.valid
		? { kind: "valid", decision: validation.value }
		: { kind: "invalid", error: validation.error };
}

/** Observer copy of a flat candidate; primitives are already immutable. */
function shallowCopy<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value;
	return (Array.isArray(value) ? [...value] : { ...value }) as T;
}

/** Append the actual result-file marker to host callback text. */
function withResultMarker(text: string, resultFile: string, tag: string): string {
	return `${text}\n\n<${tag}>${JSON.stringify(resultFile)}</${tag}>`;
}

/**
 * Run one bounded logical private inquiry. See the module header for the
 * full contract.
 */
export async function runPrivateDecision<T>(
	options: PrivateDecisionOptions<T>,
): Promise<PrivateDecisionResult<T>> {
	const { signal } = options;
	const cancelled = (): boolean =>
		signal?.aborted === true || !options.isCurrent();
	const attemptLimit = options.invalidAttemptLimit ?? INVALID_ATTEMPT_LIMIT;
	const resultTag = options.naming?.tag ?? RESULT_FILE_TAG;

	// Owned private resources: exactly one temp dir, created and removed here.
	let dir: string;
	try {
		dir = await mkdtemp(options.naming?.dirPrefix ?? RESULT_DIR_PREFIX);
	} catch (error) {
		// No fork can exist yet: report explicit no-session evidence.
		return {
			kind: "execution-error",
			error: `private decision directory: ${errorMessage(error)}`,
			session: { kind: "unavailable", reason: "no-session" },
		};
	}
	const agentDir = join(dir, "agent");
	const resultFile = join(dir, options.naming?.fileName ?? RESULT_FILE_NAME);
	let child: WatchdogChildSession | undefined;
	let abortRequested = false;
	// The exact fork locator, captured as soon as the runtime boundary knows
	// it — from the returned child or a setup error thrown after the fork
	// JSONL was created. Never inferred from sessionId or a naming guess.
	let knownSessionFile: string | undefined;
	let sessionCreated = false;

	const captureSessionFile = (file: unknown): void => {
		if (typeof file === "string" && file.length > 0) {
			knownSessionFile = file;
			sessionCreated = true;
		}
	};

	const abortChild = async (): Promise<void> => {
		if (child === undefined || abortRequested) return;
		abortRequested = true;
		try {
			await child.abort();
		} catch {
			// Abort is best-effort; result authority is already revoked.
		}
	};

	const onSignalAbort = (): void => {
		void abortChild();
	};
	signal?.addEventListener("abort", onSignalAbort, { once: true });

	const cleanup = async (): Promise<void> => {
		// Drain/cancel the exact child, then remove only the owned temp dir.
		await abortChild();
		if (child !== undefined) {
			try {
				await child.dispose();
			} catch {
				// Disposal failure must not mask the terminal result.
			}
		}
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	};

	const resetResultFile = async (): Promise<string | undefined> => {
		// Initialize {} through a no-follow descriptor pinned by fstat. An
		// unexpected replacement (directory, link, non-regular node) is a
		// filesystem failure, not a format retry: it is reported, never
		// repaired or deleted here.
		try {
			const handle = await openResultFile(
				resultFile,
				constants.O_WRONLY | constants.O_CREAT,
				0o600,
			);
			try {
				await handle.truncate(0);
				await handle.writeFile("{}", "utf8");
			} finally {
				await handle.close().catch(() => {});
			}
			return undefined;
		} catch (error) {
			return `result file initialization: ${errorMessage(error)}`;
		}
	};

	const runDecision = async (): Promise<PrivateDecisionResult<T>> => {
		// Initialize the result file to {} before the first attempt.
		const initError = await resetResultFile();
		if (initError !== undefined) {
			return { kind: "execution-error", error: initError };
		}

		try {
			await mkdir(agentDir, { recursive: true, mode: 0o700 });
		} catch (error) {
			return {
				kind: "execution-error",
				error: `private agent directory: ${errorMessage(error)}`,
			};
		}
		try {
			child = await options.runtime.fork({
				...options.fork,
				agentDir,
				resultFile,
			});
		} catch (error) {
			// A typed setup failure after fork creation carries the real
			// locator (structural check keeps the runtime import type-only).
			if (
				typeof error === "object" &&
				error !== null &&
				(error as { name?: unknown }).name === "WatchdogForkSetupError"
			) {
				captureSessionFile((error as { sessionFile?: unknown }).sessionFile);
			}
			return {
				kind: "execution-error",
				error: `private fork: ${errorMessage(error)}`,
			};
		}
		captureSessionFile(child.sessionFile);
		const sessionId = child.sessionId;
		const ownedChild = child;

		/**
		 * One attempt = prompt the child once, then evaluate its own final
		 * assistant outcome before trusting the file. Aborted/errored provider
		 * outcomes and cancelled/stale attempts are typed failures, never
		 * format corrections.
		 */
		const attempt = async (text: string): Promise<AttemptOutcome<T>> => {
			if (cancelled()) return { kind: "cancelled" };
			const startIndex = ownedChild.messages.length;
			let promptError: unknown;
			try {
				await ownedChild.prompt(withResultMarker(text, resultFile, resultTag));
			} catch (error) {
				promptError = error;
			}
			const outcome = assistantTerminalOutcome(ownedChild, startIndex);
			if (
				cancelled() ||
				abortRequested ||
				(outcome.kind === "failed" && outcome.aborted) ||
				isAbortError(promptError)
			) {
				return { kind: "cancelled" };
			}
			if (promptError !== undefined) {
				return {
					kind: "execution-error",
					error: errorMessage(promptError),
				};
			}
			if (outcome.kind === "failed") {
				return { kind: "execution-error", error: outcome.error };
			}
			if (outcome.kind === "none") {
				// No own completed assistant message: the file (possibly stale
				// JSON or an inherited reply) must not supply a result.
				return {
					kind: "execution-error",
					error: "the prompt settled without an own completed response.",
				};
			}
			// Normally settled own response; admitted writes already completed.
			// The runner's concrete format diagnostic beats generic {}
			// field validation; provider/host throws stay execution errors.
			if (typeof ownedChild.attemptError === "string") {
				return { kind: "invalid", error: ownedChild.attemptError };
			}
			return readResultFile(resultFile, options.validate);
		};

		/**
		 * One inquiry = at most `attemptLimit` consumed responses in the same
		 * child. Corrections append host text to that child; the file is reset
		 * to `{}` before the next authorized attempt.
		 */
		const runInquiry = async (
			inquiry: "initial" | "reconsideration",
			challengeFeedback?: string,
		): Promise<
			| { readonly kind: "decision"; decision: T }
			| { readonly kind: "decision-failed"; error: string }
			| { readonly kind: "cancelled" }
			| { readonly kind: "execution-error"; error: string }
		> => {
			let text = options.prompt(resultFile, challengeFeedback);
			// Notify once before the first authorized prompt of this inquiry,
			// after the child exists; a throwing callback is an execution
			// error, not a silently launched model request.
			try {
				options.onStarted?.({ inquiry, sessionId });
			} catch (error) {
				return { kind: "execution-error", error: errorMessage(error) };
			}
			if (cancelled()) return { kind: "cancelled" };
			for (let response = 0; response < attemptLimit; response++) {
				// The file is reset to {} before EVERY response attempt: the prior
				// attempt's admitted writes already settled inside `attempt`, so an
				// unchanged old object can never decide a later attempt.
				const attemptInitError = await resetResultFile();
				if (attemptInitError !== undefined) {
					return { kind: "execution-error", error: attemptInitError };
				}
				const outcome = await attempt(text);
				if (outcome.kind === "cancelled") return { kind: "cancelled" };
				if (outcome.kind === "execution-error") return outcome;
				const observation = outcome;
				try {
					options.onResponse?.({
						inquiry,
						attempt: response + 1,
						sessionId,
						outcome:
							observation.kind === "valid"
								? {
										kind: "valid",
										decision: shallowCopy(observation.decision),
									}
								: { kind: "invalid", error: observation.error },
					});
				} catch {
					// Audit failure never changes accounting or adds requests.
				}
				if (observation.kind === "valid") {
					return {
						kind: "decision",
						decision: shallowCopy(observation.decision),
					};
				}
				if (response + 1 >= attemptLimit) {
					return { kind: "decision-failed", error: observation.error };
				}
				if (cancelled()) return { kind: "cancelled" };
				text = options.correction(observation.error, resultFile);
			}
			// Unreachable: the loop bound is `attemptLimit`.
			return { kind: "decision-failed", error: "invalid decision" };
		};

		const initial = await runInquiry("initial");
		if (initial.kind === "cancelled") {
			return { kind: "cancelled", sessionId };
		}
		if (initial.kind === "execution-error") {
			return {
				kind: "execution-error",
				error: initial.error,
				sessionId,
			};
		}
		if (initial.kind === "decision-failed") {
			return {
				kind: "decision-failed",
				error: initial.error,
				sessionId,
				reconsidered: false,
			};
		}

		let candidate = initial.decision;
		let reconsidered = false;

		// One optional semantic review of the valid initial candidate.
		if (options.review !== undefined) {
			if (cancelled()) return { kind: "cancelled", sessionId };
			let feedback: string | undefined;
			try {
				// Observer copy: a mutating review cannot alter the candidate.
				feedback = await options.review(shallowCopy(candidate));
			} catch {
				// A review-service failure is incomplete review: release original.
				feedback = undefined;
			}
			if (cancelled()) return { kind: "cancelled", sessionId };
			if (feedback !== undefined) {
				// The second inquiry has its own response allowance in the
				// same child; the superseded candidate never commits.
				const second = await runInquiry("reconsideration", feedback);
				if (second.kind === "cancelled") {
					return { kind: "cancelled", sessionId };
				}
				if (second.kind === "execution-error") {
					return {
						kind: "execution-error",
						error: second.error,
						sessionId,
					};
				}
				if (second.kind === "decision-failed") {
					return {
						kind: "decision-failed",
						error: second.error,
						sessionId,
						reconsidered: true,
					};
				}
				candidate = second.decision;
				reconsidered = true;
			}
		}

		if (cancelled()) return { kind: "cancelled", sessionId };
		return {
			kind: "decision",
			decision: candidate,
			sessionId,
			reconsidered,
		};
	};

	let result: PrivateDecisionResult<T>;
	try {
		if (cancelled()) {
			result = { kind: "cancelled" };
		} else {
			result = await runDecision();
		}
	} finally {
		signal?.removeEventListener("abort", onSignalAbort);
		// Cancellation stays live through cleanup; currentness is rechecked
		// after this awaited boundary before any decision/failure can commit.
		await cleanup();
	}
	if (
		(result.kind === "decision" || result.kind === "decision-failed") &&
		cancelled()
	) {
		return { kind: "cancelled", sessionId: result.sessionId };
	}
	// Verify the known locator after settlement/disposal: only an absolute,
	// regular, readable retained JSONL is advertised as available. Any
	// verification failure degrades to a bounded unavailable reason and can
	// never alter the terminal outcome.
	result = {
		...result,
		session: await verifySessionEvidence(knownSessionFile, {
			created: sessionCreated,
			sessionId: result.sessionId,
		}),
	};
	return result;
}

/**
 * Post-settlement availability check for the exact child's native JSONL.
 * Read-only lstat/access: never deletes, repairs or replaces evidence, and
 * a filesystem failure downgrades to `unavailable` rather than throwing.
 */
async function verifySessionEvidence(
	file: string | undefined,
	context: { readonly created: boolean; readonly sessionId?: string },
): Promise<PrivateSessionEvidence> {
	const sessionId = context.sessionId;
	if (file === undefined) {
		return {
			kind: "unavailable",
			reason: context.created ? "unreadable" : "no-session",
			...(sessionId === undefined ? {} : { sessionId }),
		};
	}
	if (!isAbsolute(file)) {
		return {
			kind: "unavailable",
			reason: "not-absolute",
			...(sessionId === undefined ? {} : { sessionId }),
		};
	}
	try {
		// lstat: a symlink substituted for the child locator is rejected as
		// non-regular instead of being followed into another session file.
		if (!(await lstat(file)).isFile()) {
			return {
				kind: "unavailable",
				reason: "not-regular-file",
				...(sessionId === undefined ? {} : { sessionId }),
			};
		}
		await access(file, constants.R_OK);
	} catch (error) {
		return {
			kind: "unavailable",
			reason:
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "missing"
					: "unreadable",
			...(sessionId === undefined ? {} : { sessionId }),
		};
	}
	return {
		kind: "available",
		path: file,
		...(sessionId === undefined ? {} : { sessionId }),
	};
}
