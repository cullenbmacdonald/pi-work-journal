# pi-work-journal

A standalone [Pi](https://pi.dev) extension package for maintaining a daily work journal in a local vault (for example, Obsidian).

It supports:

- quick in-session journaling (`/journal`)
- full-day reconstruction (`/journal-reconcile`)
- end-of-day missing-item checks (`/journal-eod`)
- catch-up runs for missed days (`/journal-yesterday`, `/journal-date YYYY-MM-DD`)

---

## How it works

The extension writes to a date-based markdown file in your configured `vaultPath`.

### Entry format

For normal entries, it writes headings like:

```md
### HH:MM or HH:MM–HH:MM — <project>: <title>
```

and separates appended entries with:

```md
---
```

### Generation flow

For generation commands, it:

1. gathers session/journal context,
2. generates a draft in an isolated Pi session,
3. returns you to your original session,
4. opens a review overlay (**Write / Edit / Cancel**),
5. writes the result to the target day file.

---

## Commands

### `/journal`
Drafts a journal entry from the **current branch/session context** and appends it to today’s file.

Use this during the day when you remember to log progress.

### `/journal-write <markdown>`
Manually append an entry. The extension still applies heading/timestamp/project formatting automatically.

### `/journal-reconcile`
Performs a **full reconcile for today**:

- scans all today’s Pi sessions,
- reads today’s current journal,
- detects major work segments from message time gaps,
- generates a reconstructed full-day file,
- **rewrites today’s file** so it reads like you journaled at key moments.

### `/journal-eod`
Performs an **EOD missing-only pass for today**:

- compares today’s session activity vs today’s full journal,
- appends only missing follow-ups/loose ends/TODOs,
- avoids re-listing things already captured.

### `/journal-yesterday`
Runs yesterday catch-up in one command:

1. reconcile yesterday’s full log,
2. append yesterday’s missing-only EOD note.

### `/journal-date YYYY-MM-DD`
Same as `/journal-yesterday`, but for any explicit date.

Example:

```bash
/journal-date 2026-05-21
```

### `/journal-config`
Shows resolved config and target file details.

---

## Recommended workflow

Typical daily flow:

1. Use `/journal` a few times during the day when possible.
2. Run `/journal-reconcile` later (afternoon/evening) to rebuild missing structure.
3. Run `/journal-eod` at end of day to capture only missing loose ends/follow-ups.

If you forgot end-of-day:

- run `/journal-yesterday` the next morning (or `/journal-date YYYY-MM-DD`).

---

## Install

From git:

```bash
pi install git:github.com/cullenbmacdonald/pi-work-journal
```

From local path:

```bash
pi install /Users/you/dev/pi-work-journal
```

---

## Configuration

Config files are merged (project overrides global):

- `~/.pi/agent/work-journal.json`
- `<cwd>/.pi/work-journal.json`

Example:

```json
{
  "vaultPath": "~/Documents/Obsidian/MyVault/work-journal",
  "filePattern": "{{date}}.md"
}
```

Supported filename placeholders:

- `{{date}}` → `YYYY-MM-DD`
- `{{timestamp}}` → ISO timestamp (filesystem-safe)
