/**
 * Work Journal Extension
 *
 * Processes the current session into a structured markdown journal entry
 * and appends it to a daily worklog file in a configurable vault (e.g., Obsidian).
 *
 * Multiple sessions on the same day append to the same daily file, each
 * with a timestamped heading and project context.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/work-journal.json (global)
 * - <cwd>/.pi/work-journal.json (project-local)
 *
 * Example ~/.pi/agent/work-journal.json:
 * ```json
 * {
 *   "vaultPath": "~/Documents/Obsidian/MyVault/work-journal",
 *   "filePattern": "{{date}}.md"
 * }
 * ```
 *
 * Usage:
 * - `/journal` - process the current session into a journal entry
 * - `/journal-config` - show resolved configuration
 */

import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface WorkJournalConfig {
	/** Path to the directory where daily worklog files are written */
	vaultPath: string;
	/** Filename pattern. Supports {{date}} (YYYY-MM-DD) and {{timestamp}} (ISO) */
	filePattern: string;
}

const DEFAULT_CONFIG: WorkJournalConfig = {
	vaultPath: "~/Documents/work-journal",
	filePattern: "{{date}}-worklog.md",
};

function expandHome(p: string): string {
	if (p.startsWith("~/") || p === "~") {
		return join(process.env.HOME || "/tmp", p.slice(2));
	}
	return p;
}

function loadConfig(cwd: string): WorkJournalConfig {
	const globalConfigPath = join(getAgentDir(), "work-journal.json");
	const projectConfigPath = join(cwd, ".pi", "work-journal.json");

	let globalConfig: Partial<WorkJournalConfig> = {};
	let projectConfig: Partial<WorkJournalConfig> = {};

	if (existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
		}
	}

	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
		}
	}

	return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
}

function resolveFilename(pattern: string): string {
	const now = new Date();
	const date = now.toISOString().split("T")[0];
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	return pattern.replace(/\{\{date\}\}/g, date).replace(/\{\{timestamp\}\}/g, timestamp);
}

function getTimeString(): string {
	const now = new Date();
	return now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function getTodayDateString(): string {
	return new Date().toISOString().split("T")[0];
}

function getTodayDailyLink(): string {
	return `[[${getTodayDateString()}]]`;
}

function getProjectName(cwd: string): string {
	return basename(cwd);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("journal", {
		description: "Process the current session into a daily work journal entry",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const vaultDir = expandHome(config.vaultPath);

			if (!existsSync(vaultDir)) {
				const create = await ctx.ui.confirm(
					"Create vault directory?",
					`Journal vault path does not exist:\n${vaultDir}\n\nCreate it?`,
				);
				if (!create) {
					ctx.ui.notify("Journal cancelled. Configure vaultPath in work-journal.json", "warning");
					return;
				}
				mkdirSync(vaultDir, { recursive: true });
			}

			const filename = resolveFilename(config.filePattern);
			const filePath = join(vaultDir, filename);
			const fileExists = existsSync(filePath);
			const time = getTimeString();
			const project = getProjectName(ctx.cwd);
			const dailyLink = getTodayDailyLink();

			// Read existing content so the agent knows what's already logged today
			let existingContent = "";
			if (fileExists) {
				existingContent = readFileSync(filePath, "utf-8");
			}

			const instruction = [
				"Review this session and produce a work journal entry for today's daily worklog.",
				"",
				"## Format",
				"",
				`Your entry heading should be: ### ${time} — ${project}: <short title>`,
				"",
				"Under that heading, include whichever of these sections are relevant (skip empty ones):",
				"",
				"- **What was done** — brief summary of accomplishments",
				"- **Key decisions** — important choices and rationale",
				"- **Open threads** — things that came up but aren't finished (format as tasks: `- [ ] ...`)",
				"- **Learnings** — insights or things to remember",
				"- **Links** — PRs, files, or resources referenced",
				"",
				"## Obsidian Conventions",
				"",
				"This vault uses Obsidian. Wrap proper nouns, tools, projects, people, and key concepts",
				"in [[wikilinks]] so backlinks are created. Examples: [[Pi]], [[Obsidian]], [[TypeScript]],",
				"[[Justworks]], team member names, libraries, services, etc.",
				"Do NOT wikilink generic words — only things that are or should be their own note.",
				"",
				"Include a wikilink to today's daily note somewhere in the entry (usually in **Links**):",
				`- ${dailyLink}`,
				"",
				"## Context",
				"",
				`Target file: ${filePath}`,
				`Project: ${project} (${ctx.cwd})`,
				"",
				fileExists
					? [
							"This daily worklog already has entries from earlier sessions today:",
							"```",
							existingContent.slice(0, 2000),
							existingContent.length > 2000 ? "\n... (truncated)" : "",
							"```",
							"Your entry will be APPENDED after a `---` separator.",
							"Do NOT repeat the file header or duplicate earlier entries.",
							"Avoid duplicating TODOs that already appear above unless you have an update on them.",
					  ].join("\n")
					: `This is the first entry for today. Start with a top-level heading: \`# ${getTodayDateString()}\` followed by your entry. Include daily-note wikilink ${dailyLink}.`,
				"",
				"## Instructions",
				"",
				"Produce ONLY the raw markdown content (no code fences wrapping it).",
				"Keep it concise — this is a personal worklog, not a PR description.",
				"After you produce the entry, ask me to confirm, then call /journal-write with the content.",
			].join("\n");

			pi.sendUserMessage(instruction, { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("journal-write", {
		description: "Write a journal entry to the configured vault (provide content as argument)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /journal-write <markdown content>", "warning");
				return;
			}

			const config = loadConfig(ctx.cwd);
			const vaultDir = expandHome(config.vaultPath);

			if (!existsSync(vaultDir)) {
				mkdirSync(vaultDir, { recursive: true });
			}

			const filename = resolveFilename(config.filePattern);
			const filePath = join(vaultDir, filename);
			const fileExists = existsSync(filePath);

			if (fileExists) {
				// Append with separator — another session already wrote today
				appendFileSync(filePath, `\n\n---\n\n${args.trim()}\n`, "utf-8");
			} else {
				// First entry of the day — content should include the `# date` header
				writeFileSync(filePath, `${args.trim()}\n`, "utf-8");
			}

			ctx.ui.notify(`✅ Journal entry written to:\n${filePath}`, "info");
		},
	});

	pi.registerCommand("journal-config", {
		description: "Show current work journal configuration",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const vaultDir = expandHome(config.vaultPath);
			const filename = resolveFilename(config.filePattern);
			const filePath = join(vaultDir, filename);
			const lines = [
				"Work Journal Configuration:",
				"",
				`  Vault path:    ${config.vaultPath}`,
				`  Resolved:      ${vaultDir}`,
				`  Exists:        ${existsSync(vaultDir) ? "yes" : "NO — will be created on first use"}`,
				`  File pattern:  ${config.filePattern}`,
				`  Today's file:  ${filePath}`,
				`  File exists:   ${existsSync(filePath) ? "yes (will append)" : "no (will create)"}`,
				"",
				"Config locations (project overrides global):",
				`  Global:  ${join(getAgentDir(), "work-journal.json")}`,
				`  Project: ${join(ctx.cwd, ".pi", "work-journal.json")}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
