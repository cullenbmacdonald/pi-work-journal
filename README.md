# pi-work-journal

A standalone [Pi](https://pi.dev) extension package for writing daily work journal entries to a local vault (e.g. Obsidian).

## Features

- `/journal` — runs journal drafting in an isolated session, shows an overlay review UI, and returns you to your original session.
- `/journal-write <markdown>` — manually write an entry (heading/timestamp/project formatting is applied automatically).
- `/journal-config` — show resolved configuration and today's target file.
- `/journal-reconcile` — rewrites today's full journal by reconciling all of today's Pi sessions + existing journal content, splitting entries at major time gaps.
- `/journal-eod` — appends an end-of-day note with only missing follow-ups/loose ends/TODOs not already covered by the day log.
- `/journal-yesterday` — runs yesterday's reconcile + missing-only EOD flow in one command for catch-up.
- `/journal-date YYYY-MM-DD` — runs reconcile + missing-only EOD for a specific date.

## Install

From git:

```bash
pi install git:github.com/cullenbmacdonald/pi-work-journal
```

From local path:

```bash
pi install /Users/you/dev/pi-work-journal
```

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
