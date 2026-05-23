import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock(
	"@earendil-works/pi-coding-agent",
	() => ({
		getAgentDir: () => "/tmp",
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

describe("work-journal helpers", () => {
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
});
