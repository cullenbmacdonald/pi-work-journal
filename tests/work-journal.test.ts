import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const FAKE_AGENT_DIR = "/tmp/pi-work-journal-test-agent";

vi.mock(
	"@earendil-works/pi-coding-agent",
	() => ({
		getAgentDir: () => FAKE_AGENT_DIR,
	}),
	{ virtual: true },
);

vi.mock(
	"@earendil-works/pi-tui",
	() => ({
		matchesKey: () => false,
		visibleWidth: (s: string) => s.length,
	}),
	{ virtual: true },
);

let testables: Awaited<ReturnType<typeof loadTestables>>;

async function loadTestables() {
	const mod = await import("../extensions/work-journal");
	return mod.__testables;
}

beforeAll(async () => {
	testables = await loadTestables();
});

afterEach(() => {
	if (existsSync(FAKE_AGENT_DIR)) {
		rmSync(FAKE_AGENT_DIR, { recursive: true, force: true });
	}
});

function createSessionFile(projectSlug: string, filename: string, entries: object[]): string {
	const dir = join(FAKE_AGENT_DIR, "sessions", projectSlug);
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, filename);
	const content = entries.map((e) => JSON.stringify(e)).join("\n");
	writeFileSync(filePath, content, "utf-8");
	return filePath;
}

function makeMessageEntry(role: string, text: string, timestamp: number) {
	return {
		type: "message",
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role,
			content: text,
			timestamp,
		},
	};
}

describe("work-journal helpers", () => {
	it("resolves filenames with explicit date", () => {
		const result = testables.resolveFilename("{{date}}-worklog.md", "2026-05-22");
		expect(result).toBe("2026-05-22-worklog.md");
	});

	it("validates ISO dates strictly", () => {
		expect(testables.isIsoDateString("2026-05-22")).toBe(true);
		expect(testables.isIsoDateString("2024-02-29")).toBe(true);
		expect(testables.isIsoDateString("2025-02-29")).toBe(false);
		expect(testables.isIsoDateString("2026-5-2")).toBe(false);
		expect(testables.isIsoDateString("not-a-date")).toBe(false);
	});

	it("extracts title/body from explicit title format", () => {
		const input = "Title: Fix session carryover\n\nUpdated prompt handling.";
		const result = testables.extractTitleAndBody(input);
		expect(result.title).toBe("Fix session carryover");
		expect(result.body).toContain("Updated prompt handling");
	});

	it("splits work into segments using large time gaps", () => {
		const base = Date.parse("2026-05-22T09:00:00.000Z");
		const messages = [
			{ role: "user", text: "a", timestampMs: base },
			{ role: "assistant", text: "b", timestampMs: base + 10 * 60 * 1000 },
			{ role: "user", text: "c", timestampMs: base + 2 * 60 * 60 * 1000 },
			{ role: "assistant", text: "d", timestampMs: base + 2 * 60 * 60 * 1000 + 5 * 60 * 1000 },
		];

		const segments = testables.splitIntoWorkSegments(messages, 90);
		expect(segments).toHaveLength(2);
		expect(segments[0]?.messageCount).toBe(2);
		expect(segments[1]?.messageCount).toBe(2);
	});

	it("builds EOD missing-only instruction", () => {
		const text = testables.buildEodMissingInstruction({
			project: "pi-work-journal",
			cwd: "/tmp/pi-work-journal",
			filePath: "/tmp/journal/2026-05-22.md",
			fileExists: true,
			existingContent: "# 2026-05-22\n\n### 09:00 — proj: did x",
			dailyLink: "[[2026-05-22]]",
			todayDate: "2026-05-22",
			sessionCount: 5,
			contributingSessionCount: 3,
			transcript: "[2026-05-22T09:00:00.000Z] user: ...",
		});

		expect(text).toContain("ONLY items missing");
		expect(text).toContain("Title: EOD missing items");
		expect(text).toContain("If everything is already covered");
	});

	it("normalizes fenced markdown model output", () => {
		const input = "```markdown\n# 2026-05-22\n\n### 09:00 — proj: Start\n```";
		expect(testables.normalizeModelMarkdownOutput(input)).toBe("# 2026-05-22\n\n### 09:00 — proj: Start");
	});

	it("normalizes reconcile draft by slicing from day header", () => {
		const input =
			"Written to /tmp/file.md\n\n# 2026-05-22\n\n### 09:00 — proj: Start\n\nBody";
		expect(testables.normalizeReconcileDraft(input, "2026-05-22").startsWith("# 2026-05-22")).toBe(true);
	});

	it("rejects non-markdown reconcile summary text", () => {
		const bad = "Written to /tmp/worklog.md. The journal covers 13 entries.";
		expect(testables.isValidReconcileDraft(bad, "2026-05-22")).toBe(false);
		const good = "# 2026-05-22\n\n### 09:00 — proj: Start";
		expect(testables.isValidReconcileDraft(good, "2026-05-22")).toBe(true);
	});
});

describe("extractMessagesFromSessionFile", () => {
	it("extracts messages matching the target date", () => {
		const base = Date.parse("2026-05-22T14:00:00.000Z");
		const filePath = createSessionFile("--project-a--", "session1.jsonl", [
			makeMessageEntry("user", "hello", base),
			makeMessageEntry("assistant", "hi there", base + 5000),
			makeMessageEntry("user", "next day msg", Date.parse("2026-05-23T09:00:00.000Z")),
		]);

		const messages = testables.extractMessagesFromSessionFile(filePath, "2026-05-22");
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe("user");
		expect(messages[0].text).toBe("hello");
		expect(messages[1].role).toBe("assistant");
		expect(messages[1].text).toBe("hi there");
	});

	it("ignores non-message entries", () => {
		const base = Date.parse("2026-05-22T14:00:00.000Z");
		const filePath = createSessionFile("--project-b--", "session2.jsonl", [
			{ type: "tool_call", timestamp: new Date(base).toISOString(), tool: "bash" },
			makeMessageEntry("user", "real message", base + 1000),
			{ type: "system", timestamp: new Date(base).toISOString() },
		]);

		const messages = testables.extractMessagesFromSessionFile(filePath, "2026-05-22");
		expect(messages).toHaveLength(1);
		expect(messages[0].text).toBe("real message");
	});

	it("returns empty array for non-existent file", () => {
		const messages = testables.extractMessagesFromSessionFile("/nonexistent/path.jsonl", "2026-05-22");
		expect(messages).toHaveLength(0);
	});

	it("handles malformed lines gracefully", () => {
		const dir = join(FAKE_AGENT_DIR, "sessions", "--project-c--");
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "bad.jsonl");
		const base = Date.parse("2026-05-22T10:00:00.000Z");
		const content = [
			"not valid json",
			"",
			JSON.stringify(makeMessageEntry("user", "good line", base)),
			"{broken json{{{",
		].join("\n");
		writeFileSync(filePath, content, "utf-8");

		const messages = testables.extractMessagesFromSessionFile(filePath, "2026-05-22");
		expect(messages).toHaveLength(1);
		expect(messages[0].text).toBe("good line");
	});
});

describe("getAllSessionFilePaths", () => {
	it("returns empty array when sessions dir does not exist", () => {
		const files = testables.getAllSessionFilePaths();
		expect(files).toHaveLength(0);
	});

	it("collects .jsonl files across all project directories", () => {
		const base = Date.parse("2026-05-22T10:00:00.000Z");
		createSessionFile("--project-alpha--", "s1.jsonl", [makeMessageEntry("user", "a", base)]);
		createSessionFile("--project-alpha--", "s2.jsonl", [makeMessageEntry("user", "b", base)]);
		createSessionFile("--project-beta--", "s3.jsonl", [makeMessageEntry("user", "c", base)]);

		const files = testables.getAllSessionFilePaths();
		expect(files).toHaveLength(3);
		expect(files.some((f: string) => f.includes("--project-alpha--"))).toBe(true);
		expect(files.some((f: string) => f.includes("--project-beta--"))).toBe(true);
	});

	it("ignores non-jsonl files", () => {
		const dir = join(FAKE_AGENT_DIR, "sessions", "--project-x--");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "notes.txt"), "not a session", "utf-8");
		writeFileSync(join(dir, "real.jsonl"), JSON.stringify(makeMessageEntry("user", "hi", Date.now())), "utf-8");

		const files = testables.getAllSessionFilePaths();
		expect(files).toHaveLength(1);
		expect(files[0]).toContain("real.jsonl");
	});
});

describe("collectMessagesAcrossAllSessions", () => {
	it("collects messages from multiple projects for a target date", () => {
		const base = Date.parse("2026-05-22T09:00:00.000Z");
		createSessionFile("--project-one--", "morning.jsonl", [
			makeMessageEntry("user", "started work on feature X", base),
			makeMessageEntry("assistant", "here is the implementation", base + 60000),
		]);
		createSessionFile("--project-two--", "afternoon.jsonl", [
			makeMessageEntry("user", "reviewing PR", base + 4 * 60 * 60 * 1000),
			makeMessageEntry("assistant", "looks good", base + 4 * 60 * 60 * 1000 + 30000),
		]);
		// Different date - should not be included
		createSessionFile("--project-one--", "yesterday.jsonl", [
			makeMessageEntry("user", "old message", Date.parse("2026-05-21T15:00:00.000Z")),
		]);

		const result = testables.collectMessagesAcrossAllSessions("2026-05-22");
		expect(result.messages).toHaveLength(4);
		expect(result.contributingSessionCount).toBe(2);
		expect(result.scannedSessionCount).toBeGreaterThanOrEqual(3);
		// Should be sorted by timestamp
		expect(result.messages[0].text).toBe("started work on feature X");
		expect(result.messages[3].text).toBe("looks good");
	});

	it("deduplicates identical messages", () => {
		const base = Date.parse("2026-05-22T12:00:00.000Z");
		// Same message appearing in two files (e.g. branching)
		createSessionFile("--project-dup--", "s1.jsonl", [
			makeMessageEntry("user", "duplicated message", base),
		]);
		createSessionFile("--project-dup--", "s2.jsonl", [
			makeMessageEntry("user", "duplicated message", base),
		]);

		const result = testables.collectMessagesAcrossAllSessions("2026-05-22");
		expect(result.messages).toHaveLength(1);
	});

	it("returns zero messages when no sessions match the date", () => {
		const base = Date.parse("2026-05-21T10:00:00.000Z");
		createSessionFile("--project-z--", "old.jsonl", [
			makeMessageEntry("user", "yesterday work", base),
		]);

		const result = testables.collectMessagesAcrossAllSessions("2026-05-22");
		expect(result.messages).toHaveLength(0);
		expect(result.contributingSessionCount).toBe(0);
		expect(result.scannedSessionCount).toBe(1);
	});

	it("returns empty result when no sessions exist at all", () => {
		const result = testables.collectMessagesAcrossAllSessions("2026-05-22");
		expect(result.messages).toHaveLength(0);
		expect(result.scannedSessionCount).toBe(0);
		expect(result.contributingSessionCount).toBe(0);
	});
});
