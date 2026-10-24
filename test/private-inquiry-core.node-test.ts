/**
 * Shared conformance: Continue's accepted private-decision suite
 * (pi-continue-watchdog test/private-decision.test.ts @ 42387d7), ported
 * verbatim against the moved core. Only these seams differ:
 * - imports point at src/private-inquiry/core.ts and the utils private runtime;
 * - the consumer validator is a test-local copy of Continue's continue/unlock
 *   rules (validateDecision below), supplied through the `validate` callback;
 * - Continue's unlock-only review gate is consumer policy, applied by the
 *   test's `review` wrapper exactly as Continue's adapter must;
 * - Continue's result-file naming is passed through `naming`, proving a
 *   zero-literal-change adoption.
 */
import assert from "node:assert/strict";
import { existsSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	WatchdogChildSession,
	WatchdogForkInput,
	WatchdogRuntime,
} from "private-inquiry-subagents-runtime/watchdog-runtime";

import {
	type PayloadValidation,
	type PrivateDecisionObservation,
	type PrivateDecisionOptions,
	runPrivateDecision as runCore,
} from "../src/private-inquiry/core.js";

const TEST_TMP = process.platform === "win32" ? tmpdir() : "/var/tmp";

const REASON_TYPES = ["JOB_DONE", "NeedReview"];
const CONTINUE_REASON_TYPES = ["VERIFYING", "PROGRESS"];

/** Continue's published result-file naming (unchanged by adoption). */
const CONTINUE_NAMING = {
	tag: "watchdog_result_file",
	fileName: "decision.json",
	// Continue publishes /var/tmp; Windows CI has no /var/tmp.
	dirPrefix: join(TEST_TMP, "watchdog-decision-"),
} as const;

type ValidDecision = {
	readonly kind: "continue" | "unlock";
	readonly reasonType: string;
	readonly matchedReasonType: string;
	readonly reason: string;
};

/** Test-local copy of Continue's validateDecisionArguments rules. */
function validateDecision(args: unknown): PayloadValidation<ValidDecision> {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return { valid: false, error: "The decision result requires a JSON object with action and reason_content." };
	}
	const record = args as Record<string, unknown>;
	if (typeof record.action !== "string") {
		return { valid: false, error: "action must be one of continue or unlock (case-insensitive after trimming)." };
	}
	const action = record.action.trim().toLowerCase();
	if (action === "wait") {
		return { valid: false, error: "wait is no longer an accepted action. Use continue or unlock." };
	}
	if (action !== "continue" && action !== "unlock") {
		return { valid: false, error: "action must be one of continue or unlock (case-insensitive after trimming)." };
	}
	if (record.reason_type === undefined || record.reason_content === undefined) {
		return { valid: false, error: `${action} requires reason_type and reason_content.` };
	}
	const types = action === "continue" ? CONTINUE_REASON_TYPES : REASON_TYPES;
	const needle = typeof record.reason_type === "string" ? record.reason_type.trim().toLowerCase() : "";
	const matched = types.find((entry) => needle.length > 0 && entry.toLowerCase() === needle);
	if (matched === undefined) {
		return { valid: false, error: `${action} requires a configured reason_type.` };
	}
	const reason = typeof record.reason_content === "string" ? record.reason_content.trim() : "";
	if (reason.length === 0) {
		return { valid: false, error: `${action} requires a non-empty reason_content.` };
	}
	return { valid: true, value: { kind: action, reasonType: matched.toUpperCase(), matchedReasonType: matched, reason } };
}

type ContinueOptions = Omit<PrivateDecisionOptions<ValidDecision>, "validate"> & {
	readonly reasonTypes?: readonly string[];
	readonly continueReasonTypes?: readonly string[];
};

/** Continue adapter shape: validator + unlock-only review gate + naming. */
function runPrivateDecision(options: ContinueOptions) {
	const { reasonTypes: _reasonTypes, continueReasonTypes: _continueTypes, review, ...rest } = options;
	void _reasonTypes;
	void _continueTypes;
	return runCore<ValidDecision>({
		...rest,
		naming: CONTINUE_NAMING,
		validate: validateDecision,
		...(review === undefined
			? {}
			: { review: async (decision: ValidDecision) => decision.kind === "unlock" ? review(decision) : undefined }),
	});
}

/** What a fake child response does. */
interface FakeReply {
	/** Content written to the result file (raw string). Omitted = no write. */
	readonly write?: string;
	/** Throw from prompt() — provider/transport failure. */
	readonly throw?: Error;
	/** Terminal assistant outcome override for this response. */
	readonly stopReason?: "stop" | "error" | "aborted";
	readonly errorMessage?: string;
	/** Runner-side format diagnostic for this normally settled response. */
	readonly attemptError?: string;
	/** Settled prompt appends no own assistant message (inherited-only). */
	readonly noOwnReply?: boolean;
	/** Side effect run before the reply settles (e.g. corrupt the file). */
	readonly effect?: (resultFile: string) => void | Promise<void>;
}

interface FakeChild extends WatchdogChildSession {
	readonly prompts: readonly string[];
	readonly fileStates: readonly string[];
	readonly aborted: boolean;
}

/**
 * Fake WatchdogRuntime/child: each prompt performs one scripted response that
 * may write the real private result file. Only one fork is ever created.
 */
function createFakeRuntime(
	t: TestContext,
	responder: (response: {
		promptText: string;
		resultFile: string;
		responseIndex: number;
	}) => FakeReply | Promise<FakeReply>,
	options: {
		readonly inheritedAssistant?: boolean;
		/** Runs inside child.dispose() before it completes (e.g. abort). */
		readonly onDispose?: () => void;
		/** Native session locator reported by the child (created by the test). */
		readonly sessionFile?: string;
	} = {},
) {
	const dirs: string[] = [];
	const children: FakeChild[] = [];
	let forkInput: WatchdogForkInput | undefined;
	const disposeGate: { hold?: Promise<void> } = {};
	t.after(async () => {
		for (const child of children) await child.dispose();
	});
	const runtime: WatchdogRuntime = {
		async fork(input) {
			forkInput = input;
			dirs.push(input.agentDir);
			const prompts: string[] = [];
			const fileStates: string[] = [];
			const messages: AgentMessage[] = [];
			if (options.inheritedAssistant === true) {
				// A full fork inherits the parent's own past assistant replies.
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: "inherited" }],
					stopReason: "stop",
					timestamp: Date.now(),
				} as AgentMessage);
			}
			const state = {
				aborted: false,
				disposed: false,
				attemptError: undefined as string | undefined,
			};
			const child: FakeChild = {
				sessionId: `private-child-${children.length + 1}`,
				modelId: "fake/local",
				sessionFile: options.sessionFile,
				messages,
				get attemptError() {
					return state.attemptError;
				},
				get aborted() {
					return state.aborted;
				},
				prompts,
				fileStates,
				async prompt(text: string) {
					if (state.aborted) {
						const error = new Error("aborted");
						error.name = "AbortError";
						throw error;
					}
					prompts.push(text);
					fileStates.push(await readFile(input.resultFile, "utf8"));
					const reply = await responder({
						promptText: text,
						resultFile: input.resultFile,
						responseIndex: prompts.length,
					});
					if (reply.effect !== undefined) {
						await reply.effect(input.resultFile);
					}
					if (reply.write !== undefined && !state.aborted) {
						await writeFile(input.resultFile, reply.write);
					}
					state.attemptError = reply.attemptError;
					if (reply.noOwnReply !== true) {
						const stopReason = reply.stopReason ?? "stop";
						messages.push({
							role: "assistant",
							content: [{ type: "text", text: "fake" }],
							stopReason,
							...(reply.errorMessage === undefined
								? {}
								: { errorMessage: reply.errorMessage }),
							timestamp: Date.now(),
						} as AgentMessage);
					}
					if (reply.throw !== undefined) throw reply.throw;
				},
				async abort() {
					state.aborted = true;
				},
				async dispose() {
					options.onDispose?.();
					await disposeGate.hold;
					state.disposed = true;
				},
				subscribe() {
					return () => {};
				},
			};
			children.push(child);
			return child;
		},
		async dispose() {},
	};
	return {
		runtime,
		children,
		disposeGate,
		get forkInput() {
			return forkInput;
		},
	};
}

function baseOptions(
	runtime: WatchdogRuntime,
	overrides: Partial<ContinueOptions> = {},
): ContinueOptions {
	return {
		runtime,
		fork: {
			parent: undefined as never,
			parentProviderRegistry: undefined as never,
			cwd: TEST_TMP,
			model: "fake/local",
			retryPolicy: "disabled",
		},
		reasonTypes: REASON_TYPES,
		continueReasonTypes: CONTINUE_REASON_TYPES,
		isCurrent: () => true,
		prompt: () => "Submit the decision now.",
		correction: (error) => `Invalid: ${error} Correct it.`,
		...overrides,
	};
}

const VALID_UNLOCK =
	'{"action":"unlock","reason_type":"JOB_DONE","reason_content":"Done."}';
const VALID_CONTINUE =
	'{"action":"continue","reason_type":" verifying ","reason_content":"Run tests."}';

test("one valid file response returns a terminal decision and cleans up", async (t) => {
	const fixture = createFakeRuntime(t, () => ({
		write: VALID_CONTINUE,
	}));
	const result = await runPrivateDecision(baseOptions(fixture.runtime));
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.deepEqual(result.decision, {
		kind: "continue",
		reasonType: "VERIFYING",
		matchedReasonType: "VERIFYING",
		reason: "Run tests.",
	});
	const { children, forkInput } = fixture;
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.deepEqual(result.decision, {
		kind: "continue",
		reasonType: "VERIFYING",
		matchedReasonType: "VERIFYING",
		reason: "Run tests.",
	});
	assert.equal(result.reconsidered, false);
	assert.equal(result.sessionId, children[0]!.sessionId);
	assert.equal(children.length, 1, "exactly one child");
	assert.equal(children[0]!.prompts.length, 1);
	assert.ok(forkInput !== undefined);
	const ownedDir = dirname(forkInput.resultFile);
	// The prompt carries the actual JSON-encoded path inside the marker.
	assert.match(
		children[0]!.prompts[0]!,
		process.platform === "win32"
			? /<watchdog_result_file>".*watchdog-decision-[^"]*decision\.json"<\/watchdog_result_file>$/
			: /<watchdog_result_file>"\/var\/tmp\/watchdog-decision-[^"]*\/decision\.json"<\/watchdog_result_file>$/,
	);
	assert.equal(forkInput.resultFile.endsWith("decision.json"), true);
	// Owned temp resources are deleted; nothing durable remains.
	assert.equal(existsSync(ownedDir), false);
});

test("invalid then valid corrects in the same child with the file reset", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1
			? { write: '{"reason_type":"JOB_DONE","reason_content":"No action."}' }
			: { write: VALID_UNLOCK },
	);
	const corrections: string[] = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			correction: (error) => {
				corrections.push(error);
				return `Fix: ${error}`;
			},
		}),
	);
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.equal(result.decision.kind, "unlock");
	assert.equal(children.length, 1);
	assert.equal(children[0]!.prompts.length, 2);
	// The same child saw {} before every authorized attempt.
	assert.deepEqual(children[0]!.fileStates, ["{}", "{}"]);
	// The concrete validator diagnostic reached the correction prompt.
	assert.equal(corrections.length, 1);
	assert.match(corrections[0]!, /action must be one of continue or unlock/);
	assert.match(
		children[0]!.prompts[1]!,
		/action must be one of continue or unlock/,
	);
});

test("three invalid responses fail once with no fourth request", async (t) => {
	const { runtime, children } = createFakeRuntime(t, () => ({
		write: '{"action":"wait","reason_content":"Wait.","wait_seconds":60}',
	}));
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "decision-failed");
	if (result.kind !== "decision-failed") return;
	assert.match(result.error, /wait is no longer an accepted action/);
	assert.equal(result.reconsidered, false);
	assert.equal(children[0]!.prompts.length, 3);
});

test("malformed and non-object JSON are invalid format responses", async (t) => {
	const writes = [
		'{"action":"unlock"', // malformed
		"[1,2]", // non-object
		VALID_CONTINUE,
	];
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) => ({
		write: writes[responseIndex - 1]!,
	}));
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "decision");
	assert.equal(children[0]!.prompts.length, 3);
	assert.deepEqual(children[0]!.fileStates, ["{}", "{}", "{}"]);
});

test("an untouched {} file is one consumed invalid response", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1 ? {} : { write: VALID_CONTINUE },
	);
	const observations: PrivateDecisionObservation[] = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			onResponse: (observation) => observations.push(observation),
		}),
	);
	assert.equal(result.kind, "decision");
	assert.equal(children[0]!.prompts.length, 2);
	assert.deepEqual(
		observations.map((o) => [o.inquiry, o.attempt, o.outcome.kind]),
		[
			["initial", 1, "invalid"],
			["initial", 2, "valid"],
		],
	);
});

test("provider failure is an execution error, not a format attempt", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1
			? {
					throw: new Error("provider exploded"),
					stopReason: "error",
					errorMessage: "provider exploded",
				}
			: { write: VALID_CONTINUE },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	if (result.kind !== "execution-error") return;
	assert.match(result.error, /provider exploded/);
	assert.equal(children[0]!.prompts.length, 1, "no correction invented");
});

test("host file failure is an execution error, never a format failure", async (t) => {
	const { runtime, children } = createFakeRuntime(t, () => ({
		// Delete the result file instead of writing it: unreadable host file.
		effect: async (file) => {
			await import("node:fs/promises").then((fs) => fs.rm(file));
		},
	}));
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.match(
		(result as { error?: string }).error ?? "",
		/result file unreadable/,
	);
	assert.equal(children[0]!.prompts.length, 1);
});

test("a directory replacement is a terminal filesystem error, no retry", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1
			? {
					effect: async (file) => {
						// Replace the designated file with a directory.
						const fs = await import("node:fs/promises");
						await fs.rm(file);
						await fs.mkdir(file);
					},
				}
			: { write: VALID_CONTINUE },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.match(
		(result as { error?: string }).error ?? "",
		/result file unreadable|not the designated regular file/,
	);
	assert.equal(children[0]!.prompts.length, 1, "no extra model call");
});

test("a symlink result path is a terminal filesystem error, never followed", async (t) => {
	const { runtime, children } = createFakeRuntime(t, () => ({
		effect: async (file) => {
			const fs = await import("node:fs/promises");
			await fs.rm(file);
			const target = `${file}.target`;
			await fs.writeFile(target, VALID_CONTINUE);
			await fs.symlink(target, file);
		},
	}));
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.match(
		(result as { error?: string }).error ?? "",
		/result file unreadable|not the designated regular file/,
	);
	assert.equal(children[0]!.prompts.length, 1, "no extra model call");
});

test("abort cancels the exact child and a late file never commits", async (t) => {
	const controller = new AbortController();
	const { runtime, children } = createFakeRuntime(
		t,
		() =>
			new Promise<FakeReply>((resolve) => {
				// Write a valid file only after cancellation, then abort the run.
				queueMicrotask(() => {
					controller.abort();
					resolve({ write: VALID_CONTINUE });
				});
			}),
	);
	const result = await runPrivateDecision(
		baseOptions(runtime, { signal: controller.signal }),
	);
	assert.equal(result.kind, "cancelled");
	assert.equal(children[0]!.aborted, true, "exact child aborted");
});

test("a stale operation is cancelled without consuming its result", async (t) => {
	let current = true;
	const { runtime, children } = createFakeRuntime(t, () => {
		current = false; // ownership lost while the response settled
		return { write: VALID_CONTINUE };
	});
	const result = await runPrivateDecision(
		baseOptions(runtime, { isCurrent: () => current }),
	);
	assert.equal(result.kind, "cancelled");
	assert.equal(children[0]!.aborted, true);
});

test("cancelled before start creates no child", async (t) => {
	const controller = new AbortController();
	controller.abort();
	const { runtime, children } = createFakeRuntime(t, () => ({
		write: VALID_CONTINUE,
	}));
	const result = await runPrivateDecision(
		baseOptions(runtime, { signal: controller.signal }),
	);
	assert.equal(result.kind, "cancelled");
	assert.equal(children.length, 0, "no fork on an already-dead signal");
});

test("a definite challenge opens one reconsideration in the same child", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1 ? { write: VALID_UNLOCK } : { write: VALID_CONTINUE },
	);
	const prompts: Array<[string, string | undefined]> = [];
	const reviews: string[] = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			prompt: (file, feedback) => {
				prompts.push([file, feedback]);
				return "Decide.";
			},
			review: async (decision) => {
				reviews.push(decision.kind);
				return "challenge feedback: stop basis unproven";
			},
		}),
	);
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.equal(result.decision.kind, "continue");
	assert.equal(result.reconsidered, true);
	assert.equal(children.length, 1, "same child across inquiries");
	assert.deepEqual(reviews, ["unlock"]);
	// Second prompt carried the definite challenge feedback.
	assert.equal(prompts.length, 2);
	assert.equal(prompts[1]![1], "challenge feedback: stop basis unproven");
	// File reset to {} before the reconsideration's first response.
	assert.deepEqual(children[0]!.fileStates, ["{}", "{}"]);
});

test("unsupported review releases the original unlock candidate", async (t) => {
	const { runtime } = createFakeRuntime(t, () => ({ write: VALID_UNLOCK }));
	const result = await runPrivateDecision(
		baseOptions(runtime, { review: async () => undefined }),
	);
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.equal(result.decision.kind, "unlock");
	assert.equal(result.reconsidered, false);
});

test("review throwing releases the original candidate", async (t) => {
	const { runtime } = createFakeRuntime(t, () => ({ write: VALID_UNLOCK }));
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			review: async () => {
				throw new Error("service down");
			},
		}),
	);
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.equal(result.decision.kind, "unlock");
});

test("review is never invoked for continue or the replacement", async (t) => {
	const replies = [VALID_UNLOCK, VALID_UNLOCK];
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) => ({
		write: replies[responseIndex - 1]!,
	}));
	const seen: string[] = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			review: async (decision) => {
				seen.push(decision.kind);
				return seen.length === 1 ? "challenged once" : "must not happen";
			},
		}),
	);
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.equal(result.decision.kind, "unlock");
	assert.equal(result.reconsidered, true);
	assert.deepEqual(seen, ["unlock"], "no second review of the replacement");
	assert.equal(children[0]!.prompts.length, 2);
});

test("review is skipped entirely for a continue candidate", async (t) => {
	const { runtime } = createFakeRuntime(t, () => ({ write: VALID_CONTINUE }));
	let called = 0;
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			review: async () => {
				called++;
				return "challenge";
			},
		}),
	);
	assert.equal(result.kind, "decision");
	assert.equal(called, 0);
});

test("six-response bound: two inquiries share one child, each capped at three", async (t) => {
	// initial: invalid, invalid, valid unlock (3) → challenge →
	// reconsideration: invalid, invalid, invalid (3) → decision-failed.
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) => {
		if (responseIndex <= 2) {
			return { write: '{"action":"bogus"}' };
		}
		if (responseIndex === 3) return { write: VALID_UNLOCK };
		return { write: '{"action":"also-bogus"}' };
	});
	const result = await runPrivateDecision(
		baseOptions(runtime, { review: async () => "definite challenge" }),
	);
	assert.equal(result.kind, "decision-failed");
	if (result.kind === "decision-failed") {
		assert.equal(result.reconsidered, true);
	}
	assert.equal(children[0]!.prompts.length, 6, "at most six consumed responses");
	assert.equal(children.length, 1);
});

test("a throwing audit callback changes neither decision nor accounting", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1
			? { write: '{"action":"bogus"}' }
			: { write: VALID_CONTINUE },
	);
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			onResponse: () => {
				throw new Error("audit blew up");
			},
		}),
	);
	assert.equal(result.kind, "decision");
	assert.equal(children[0]!.prompts.length, 2, "no extra model requests");
});

test("fork setup failure is an execution error without a decision", async () => {
	const runtime: WatchdogRuntime = {
		async fork() {
			throw new Error("no full-fork projection");
		},
		async dispose() {},
	};
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.match(
		(result as { error?: string }).error ?? "",
		/no full-fork projection/,
	);
});

test("a settled prompt with no own reply cannot borrow an inherited response or a stale file", async (t) => {
	const { runtime, children } = createFakeRuntime(
		t,
		() => ({
			// The child settles without appending its own assistant message;
			// the file still holds a valid-looking stale object.
			noOwnReply: true,
			write: VALID_CONTINUE,
		}),
		{ inheritedAssistant: true },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.match(
		(result as { error?: string }).error ?? "",
		/without an own completed response/,
	);
	assert.equal(children[0]!.prompts.length, 1);
});

test("a stale result read before a later recheck cannot commit", async (t) => {
	let current = true;
	const { runtime } = createFakeRuntime(t, () => ({ write: VALID_CONTINUE }));
	let checkedAfterRead = 0;
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			isCurrent: () => current,
			onResponse: () => {
				// Ownership is lost after the file read but before commit.
				checkedAfterRead++;
				current = false;
			},
		}),
	);
	assert.equal(result.kind, "cancelled");
	assert.ok(checkedAfterRead >= 1);
});

test("cancellation during cleanup still revokes a decided candidate", async (t) => {
	const controller = new AbortController();
	const { runtime, children, disposeGate } = createFakeRuntime(
		t,
		() => ({ write: VALID_CONTINUE }),
		{
			onDispose: () => {
				// The decision was made; abort lands mid-disposal.
				controller.abort();
				releaseDispose();
			},
		},
	);
	let releaseDispose: () => void = () => {};
	disposeGate.hold = new Promise<void>((resolve) => {
		releaseDispose = resolve;
	});
	const result = await runPrivateDecision(
		baseOptions(runtime, { signal: controller.signal }),
	);
	assert.equal(result.kind, "cancelled");
	assert.equal(children[0]!.aborted, true);
});

test("onStarted fires once per inquiry before its first authorized prompt", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1 ? { write: VALID_UNLOCK } : { write: VALID_CONTINUE },
	);
	const events: Array<{ inquiry: string; sessionId: string; at: number }> = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			onStarted: ({ inquiry, sessionId }) => {
				events.push({
					inquiry,
					sessionId,
					at: children[0]?.prompts.length ?? -1,
				});
			},
			review: async () => "challenge",
		}),
	);
	assert.equal(result.kind, "decision");
	assert.deepEqual(
		events.map((event) => [event.inquiry, event.at]),
		[
			["initial", 0],
			["reconsideration", 1],
		],
	);
	assert.equal(events[0]!.sessionId, children[0]!.sessionId);
});

test("a throwing onStarted is an execution error without a model request", async (t) => {
	const { runtime, children } = createFakeRuntime(t, () => ({
		write: VALID_CONTINUE,
	}));
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			onStarted: () => {
				throw new Error("lifecycle blew up");
			},
		}),
	);
	assert.equal(result.kind, "execution-error");
	assert.match((result as { error?: string }).error ?? "", /lifecycle blew up/);
	assert.equal(children[0]!.prompts.length, 0, "no silent model request");
});

test("a runner attemptError supplies the concrete format diagnostic", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1
			? {
					// Runner-rejected batch: file stays at the initialized {}.
					attemptError:
						"Expected exactly one write call to the designated decision result file.",
				}
			: { write: VALID_CONTINUE },
	);
	const corrections: string[] = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			correction: (error) => {
				corrections.push(error);
				return `Fix: ${error}`;
			},
		}),
	);
	assert.equal(result.kind, "decision");
	assert.equal(children[0]!.prompts.length, 2);
	assert.equal(corrections.length, 1);
	assert.match(corrections[0]!, /exactly one write call/);
});

test("review and audit callbacks receive copies that cannot mutate the candidate", async (t) => {
	const { runtime } = createFakeRuntime(t, () => ({ write: VALID_UNLOCK }));
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			onResponse: (observation) => {
				if (observation.outcome.kind === "valid") {
					// Mutating the audit copy must not alter the accepted result.
					(observation.outcome.decision as { reason: string }).reason =
						"poisoned";
				}
			},
			review: async (decision) => {
				(decision as { reason: string }).reason = "poisoned";
				return undefined;
			},
		}),
	);
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.equal(result.decision.kind, "unlock");
	assert.equal(result.decision.reason, "Done.");
});

test("agentDir exists before runtime.fork is invoked", async () => {
	let existedAtFork = false;
	const runtime: WatchdogRuntime = {
		async fork(input) {
			existedAtFork = existsSync(input.agentDir);
			throw new Error("stop after check");
		},
		async dispose() {},
	};
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.equal(existedAtFork, true, "host created agentDir before fork");
});

// --- Final-failure session evidence (retain-failed-watchdog-sessions 1.1-1.3)

/** Real native JSONL locator for evidence tests, created by the test itself. */
async function sessionFixture(t: TestContext): Promise<{ dir: string; file: string }> {
	const dir = await mkdtemp(join(TEST_TMP, "piu-session-"));
	const file = join(dir, "child-session.jsonl");
	await writeFile(file, '{"type":"session"}\n{"type":"message"}\n', "utf8");
	t.after(() => rm(dir, { recursive: true, force: true }));
	return { dir, file };
}

test("a retained session JSONL survives child disposal on a terminal failure", async (t) => {
	const { file } = await sessionFixture(t);
	const { runtime, children } = createFakeRuntime(
		t,
		() => ({
			throw: new Error("provider exploded"),
			stopReason: "error",
			errorMessage: "provider exploded",
		}),
		{ sessionFile: file },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.equal(children[0]!.aborted, true, "child settled before evidence check");
	assert.deepEqual(result.session, {
		kind: "available",
		path: file,
		sessionId: children[0]!.sessionId,
	});
	// The exact native file is intact and readable after cleanup.
	assert.match(await readFile(file, "utf8"), /"type":"message"/);
});

test("exhausted corrections keep the same child's available session path", async (t) => {
	const { file } = await sessionFixture(t);
	const { runtime, children } = createFakeRuntime(
		t,
		() => ({ write: '{"action":"wait"}' }),
		{ sessionFile: file },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "decision-failed");
	assert.equal(children[0]!.prompts.length, 3, "no extra request for evidence");
	assert.deepEqual(result.session, {
		kind: "available",
		path: file,
		sessionId: children[0]!.sessionId,
	});
});

test("failed reconsideration evidence still identifies the same child", async (t) => {
	const { file } = await sessionFixture(t);
	const { runtime, children } = createFakeRuntime(
		t,
		({ responseIndex }) =>
			responseIndex === 1 ? { write: VALID_UNLOCK } : { write: '{"action":"bogus"}' },
		{ sessionFile: file },
	);
	const result = await runPrivateDecision(
		baseOptions(runtime, { review: async () => "definite challenge" }),
	);
	assert.equal(result.kind, "decision-failed");
	if (result.kind !== "decision-failed") return;
	assert.equal(result.reconsidered, true);
	assert.equal(children.length, 1, "initial + reconsideration share one child");
	assert.deepEqual(result.session, {
		kind: "available",
		path: file,
		sessionId: children[0]!.sessionId,
	});
});

test("setup failure before any fork reports no session", async () => {
	const runtime: WatchdogRuntime = {
		async fork() {
			throw new Error("no full-fork projection");
		},
		async dispose() {},
	};
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.deepEqual(result.session, { kind: "unavailable", reason: "no-session" });
});

test("a typed setup failure after fork creation preserves the real locator", async (t) => {
	const { file } = await sessionFixture(t);
	const { WatchdogForkSetupError } = await import(
		"private-inquiry-subagents-runtime/watchdog-runtime"
	);
	const runtime: WatchdogRuntime = {
		async fork() {
			throw new WatchdogForkSetupError("child startup blew up", file);
		},
		async dispose() {},
	};
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.match((result as { error?: string }).error ?? "", /child startup blew up/);
	assert.deepEqual(result.session, { kind: "available", path: file });
});

test("a missing session file is unavailable, never a claimed path", async (t) => {
	const dir = await mkdtemp(join(TEST_TMP, "piu-session-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const gone = join(dir, "deleted.jsonl");
	await writeFile(gone, "{}\n", "utf8");
	const { runtime, children } = createFakeRuntime(
		t,
		async () => {
			await rm(gone, { force: true });
			return { write: '{"action":"wait"}' };
		},
		{ sessionFile: gone },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "decision-failed");
	assert.equal(children[0]!.prompts.length, 3);
	assert.deepEqual(result.session, {
		kind: "unavailable",
		reason: "missing",
		sessionId: children[0]!.sessionId,
	});
});

test("a non-regular locator is unavailable, never advertised as saved", async (t) => {
	const dir = await mkdtemp(join(TEST_TMP, "piu-session-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const { runtime } = createFakeRuntime(
		t,
		() => ({ throw: new Error("boom"), stopReason: "error" }),
		{ sessionFile: dir },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.equal(result.session?.kind, "unavailable");
	assert.equal(
		result.session?.kind === "unavailable" ? result.session.reason : "",
		"not-regular-file",
	);
});

test("a relative locator is rejected as not absolute", async (t) => {
	const { runtime } = createFakeRuntime(
		t,
		() => ({ throw: new Error("boom"), stopReason: "error" }),
		{ sessionFile: "relative/child.jsonl" },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.equal(
		result.session?.kind === "unavailable" ? result.session.reason : "",
		"not-absolute",
	);
});

test("cancellation reports evidence without changing the cancelled outcome", async (t) => {
	const { file } = await sessionFixture(t);
	let current = true;
	const { runtime, children } = createFakeRuntime(
		t,
		() => {
			current = false;
			return { write: VALID_CONTINUE };
		},
		{ sessionFile: file },
	);
	const result = await runPrivateDecision(
		baseOptions(runtime, { isCurrent: () => current }),
	);
	assert.equal(result.kind, "cancelled");
	assert.equal(children[0]!.aborted, true);
	assert.deepEqual(result.session, {
		kind: "available",
		path: file,
		sessionId: children[0]!.sessionId,
	});
});

test("a locator replaced by a symlink before verification is unavailable", async (t) => {
	const dir = await mkdtemp(join(TEST_TMP, "piu-session-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const child = join(dir, "child.jsonl");
	const parent = join(dir, "parent.jsonl");
	await writeFile(child, '{"type":"session","name":"child"}\n', "utf8");
	await writeFile(parent, '{"type":"session","name":"PARENT-SUBSTITUTE"}\n', "utf8");
	const { runtime } = createFakeRuntime(
		t,
		() => ({ throw: new Error("boom"), stopReason: "error" }),
		{
			sessionFile: child,
			// Substitute the real child locator with a symlink into the parent
			// session during disposal, before the post-settlement check runs.
			onDispose: () => {
				if (!existsSync(child)) return; // idempotent across the extra t.after dispose
				rmSync(child);
				symlinkSync(parent, child);
			},
		},
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error", "original failure unchanged");
	assert.equal(
		result.session?.kind === "unavailable" ? result.session.reason : "",
		"not-regular-file",
		"symlink locator rejected, never followed into the parent",
	);
	if (result.session?.kind === "unavailable") {
		assert.equal("path" in result.session, false, "no parent path advertised");
	}
});

test("pre-fork directory failure reports explicit no-session evidence", async () => {
	let forkCalls = 0;
	const runtime: WatchdogRuntime = {
		async fork() {
			forkCalls++;
			throw new Error("unreachable");
		},
		async dispose() {},
	};
	// runCore directly: the consumer-shaped wrapper pins its own naming.
	const result = await runCore({
		runtime,
		fork: baseOptions(runtime).fork,
		isCurrent: () => true,
		naming: {
			tag: "watchdog_result_file",
			fileName: "decision.json",
			dirPrefix: join(TEST_TMP, "piu-definitely-missing-parent", "nested-"),
		},
		validate: validateDecision,
		prompt: () => "Submit the decision now.",
		correction: (error) => `Invalid: ${error} Correct it.`,
	});
	assert.equal(result.kind, "execution-error");
	assert.match((result as { error?: string }).error ?? "", /private decision directory/);
	assert.equal(forkCalls, 0, "no fork attempted");
	assert.deepEqual(result.session, { kind: "unavailable", reason: "no-session" });
});

test("evidence verification never spends an extra model request on success", async (t) => {
	const { file } = await sessionFixture(t);
	const { runtime, children } = createFakeRuntime(
		t,
		() => ({ write: VALID_CONTINUE }),
		{ sessionFile: file },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "decision");
	assert.equal(children[0]!.prompts.length, 1);
	assert.deepEqual(result.session, {
		kind: "available",
		path: file,
		sessionId: children[0]!.sessionId,
	});
});
