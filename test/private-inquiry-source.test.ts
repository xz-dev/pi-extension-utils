import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
	captureAnchor,
	isReplayableEntry,
	latestReplayableAnchor,
	PrivateInquirySetupError,
	type ReplayableEntry,
} from "../src/private-inquiry.js";

// POSIX: /var/tmp (not a RAM-backed /tmp); elsewhere the OS temp dir.
const TEST_TMP = process.platform === "win32" ? tmpdir() : "/var/tmp";

function entry(id: string, parentId: string | null, message?: ReplayableEntry["message"], type = "message"): ReplayableEntry {
	return { id, parentId, type: type === "message" ? "message" : type, ...(message === undefined ? {} : { message }) };
}

function assistantToolUse(id: string, parentId: string | null, ...callIds: string[]) {
	return entry(id, parentId, { role: "assistant", stopReason: "toolUse", content: callIds.map((callId) => ({ type: "toolCall", id: callId })) });
}

function toolResult(id: string, parentId: string, callId: string) {
	return entry(id, parentId, { role: "toolResult", content: [{ type: "toolResult", toolCallId: callId }] });
}

it("isReplayableEntry requires a closed ancestor prefix, not answers after the anchor", () => {
	const user = entry("u", null, { role: "user" });
	const assistant = assistantToolUse("a", "u", "call");
	const result = toolResult("t", "a", "call");
	const entries = [user, assistant, result];
	expect(isReplayableEntry(entries, user)).toBe(true);
	expect(isReplayableEntry(entries, assistant)).toBe(false);
	expect(isReplayableEntry(entries, result)).toBe(true);
	expect(latestReplayableAnchor(entries, "a")).toBe("u");
	expect(() => captureAnchor({ getEntries: () => entries, getLeafId: () => "t" }, "a")).toThrow(PrivateInquirySetupError);
});

it("captureAnchor excludes a multi-tool batch until every result is in its ancestor prefix", () => {
	const entries = [
		entry("u", null, { role: "user" }),
		assistantToolUse("a", "u", "hold", "read"),
		toolResult("read-result", "a", "read"),
	];
	const parent = { getEntries: () => entries, getLeafId: () => entries.at(-1)!.id };
	expect(captureAnchor(parent)).toBe("u");
	expect(isReplayableEntry(entries, entries[2]!)).toBe(false);
	expect(() => captureAnchor(parent, "read-result")).toThrow(PrivateInquirySetupError);
	entries.push(toolResult("hold-result", "read-result", "hold"));
	expect(captureAnchor(parent)).toBe("hold-result");
	expect(isReplayableEntry(entries, entries[3]!)).toBe(true);
});

it("custom accounting metadata cannot make an open tool batch replayable", () => {
	const entries = [
		entry("u", null, { role: "user" }),
		assistantToolUse("a", "u", "hold", "read"),
		entry("accounting", "a", undefined, "custom"),
	];
	const parent = { getEntries: () => entries, getLeafId: () => "accounting" };
	expect(captureAnchor(parent)).toBe("u");
	expect(isReplayableEntry(entries, entries[2]!)).toBe(false);
	expect(() => captureAnchor(parent, "accounting")).toThrow(PrivateInquirySetupError);
});

it("tool replies on a sibling branch do not close the selected branch's batch", () => {
	const entries = [
		entry("u", null, { role: "user" }),
		assistantToolUse("a", "u", "call"),
		toolResult("sibling-result", "u", "call"),
		entry("current", "a", undefined, "custom"),
	];
	expect(latestReplayableAnchor(entries, "current")).toBe("u");
	expect(isReplayableEntry(entries, entries[1]!)).toBe(false);
	entries.push(toolResult("own-result", "current", "call"));
	entries.push(assistantToolUse("other-open-batch", "u", "other-call"));
	expect(latestReplayableAnchor(entries, "own-result")).toBe("own-result");
});

it("latestReplayableAnchor walks back past an open tool batch to the last complete entry", () => {
	const entries = [
		entry("u1", null, { role: "user" }),
		entry("a1", "u1", { role: "assistant", stopReason: "stop", content: [] }),
		// open batch: toolUse with no toolResult
		assistantToolUse("a2", "a1", "call-1"),
	];
	expect(latestReplayableAnchor(entries, "a2")).toBe("a1");
	// leaf itself replayable → itself
	expect(latestReplayableAnchor(entries, "a1")).toBe("a1");
	// all open → undefined
	const onlyOpen = [entry("u0", null, { role: "user" }), assistantToolUse("a0", "u0", "c")];
	expect(latestReplayableAnchor(onlyOpen, "a0")).toBe("u0");
	expect(latestReplayableAnchor([assistantToolUse("solo", null, "c")], "solo")).toBeUndefined();
	expect(latestReplayableAnchor([], null)).toBeUndefined();
});

it("captureAnchor freezes the replayable anchor and throws a typed setup error when none exists", async () => {
	const root = await mkdtemp(join(TEST_TMP, "piu-capture-"));
	try {
		const manager = SessionManager.create(root);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call-1", name: "bash", arguments: {} },
				{ type: "toolCall", id: "call-2", name: "read", arguments: {} },
			],
			stopReason: "toolUse",
			provider: "piu-test" as never,
			api: "openai-completions" as never,
			model: "local" as never,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as never,
			timestamp: Date.now(),
		});
		const entries = manager.getEntries() as unknown as ReplayableEntry[];
		// anchor = the user message, not the open toolUse leaf
		expect(captureAnchor(manager)).toBe(entries[0]!.id);
		// One result does not close a two-call batch, nor does trailing custom metadata.
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		});
		expect(captureAnchor(manager)).toBe(entries[0]!.id);
		const metadataId = manager.appendCustomEntry("pi-reflect-watchdog:accounting-boundary", { version: 1 });
		expect(captureAnchor(manager)).toBe(entries[0]!.id);
		expect(() => captureAnchor(manager, metadataId)).toThrow(PrivateInquirySetupError);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "read",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: Date.now(),
		});
		const closed = manager.getEntries() as unknown as ReplayableEntry[];
		expect(captureAnchor(manager)).toBe(closed.at(-1)!.id);
		// An explicit open-batch anchor is rejected, not silently replaced.
		const reopened = SessionManager.create(root);
		reopened.appendMessage({ role: "user", content: "again", timestamp: Date.now() });
		const openId = reopened.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-2", name: "bash", arguments: {} }],
			stopReason: "toolUse",
			provider: "piu-test" as never,
			api: "openai-completions" as never,
			model: "local" as never,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as never,
			timestamp: Date.now(),
		});
		expect(() => captureAnchor(reopened, openId)).toThrow(PrivateInquirySetupError);

		const empty = SessionManager.create(root);
		// no entries at all → typed setup failure
		let threw: unknown;
		try {
			captureAnchor(empty);
		} catch (error) {
			threw = error;
		}
		expect(threw).toBeInstanceOf(PrivateInquirySetupError);
		expect((threw as PrivateInquirySetupError).reason).toBe("no-replayable-anchor");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("importing the subpath loads neither the private runtime nor the Pi SDK", async () => {
	const root = resolve(import.meta.dirname, "..");
	const probe = [
		"const { registerHooks } = await import('node:module');",
		"if (typeof registerHooks !== 'function') { console.log('[]'); process.exit(0); }",
		"const loaded = [];",
		"registerHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx); loaded.push(r.url); return r; } });",
		"await import(" + JSON.stringify(pathToFileURL(resolve(root, "src/private-inquiry.ts")).href) + ");",
		"const bad = loaded.filter((url) => /pi-coding-agent|private-inquiry-subagents-runtime|pi-agent-core|pi-ai/.test(url));",
		"console.log(JSON.stringify(bad));",
	].join("\n");
	const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], { cwd: root, timeout: 60_000 });
	expect(JSON.parse(stdout.trim().split("\n").pop()!)).toEqual([]);
});

