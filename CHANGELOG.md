# Changelog

What changed in each version of lot-map, newest first. To get a new version, see [Updating](README.md#updating).

## 0.6.0 (2026-11-12)

- The map in a terminal: in iTerm2, kitty and Ghostty the pane shows it as a picture above the rows, moving as it does in the desktop app; with the new option `terminalView` it is drawn in the terminal's own characters instead, in any terminal, as `ring`, `lanes`, `tiles` or `city`. The new option `cellShape` keeps it round on the terminal's cells. See [In a terminal](README.md#in-a-terminal).

## 0.5.0 (2026-11-11)

- Back on the Hooks station: the rows for a hook that asked for permission and for a check that took a moment. They went in 0.4.0, when the hook that sees them was removed for a plugin catalogue's rules; that catalogue takes mods only from organizations it has verified, so the hook is back as it was in 0.3.9.
- The README and the privacy page say what that hook does: it reads what settings hooks decided and hands the decision on unchanged.

## 0.4.2 (2026-11-11)

- A privacy page, [PRIVACY.md](PRIVACY.md): what the mod is handed, what it keeps and what it does not do. `plugin.json` links to it. The map itself is unchanged.

## 0.4.1 (2026-11-11)

- More for a plugin catalogue's listing: a support link to this repository's issues, and keywords. The map itself is unchanged.

## 0.4.0 (2026-11-11)

- The mod no longer has a hook on permission checks. A settings hook's refusal is read from the error the refused call returns, so a refused call and the hook that stopped it still show, with the first line of the reason when `hookReasons` is on.
- Gone with that hook: the rows for a hook that asked for permission and for a check that took a moment.
- The README says what each of the mod's hooks does.

## 0.3.9 (2026-11-11)

- What a plugin catalogue shows about the mod: an icon, the author, and links to this repository. The map itself is unchanged.
- The MP4 copy of the demo is no longer in the repository; the GIF in the README shows the same session.

## 0.3.8 (2026-11-11)

- Italian labels: `language` takes `it`. Contributed by kesi26. (#20)

## 0.3.7 (2026-11-11)

- Background work stays on the map until it ends: a command sent to the background, a monitor, a background subagent or a workflow keeps its row open, and the row closes when the task reports back. A task that failed leaves a fault on its station. (#17)
- A background task's report is no longer drawn as a new message of yours.
- Monitor has its own label on the Shell station.

## 0.3.6 (2026-11-11)

- New option `colors`: colours of your own, by name, as `name=#rrggbb`. (#15)

## 0.3.5 (2026-11-11)

- The route is softer on a light surface, and each leg fades by itself: it stays for 40 seconds and fades over 20. (#14)

## 0.3.4 (2026-11-11)

- The PowerShell tool is read the same way as Bash, with PowerShell's own command names. (#13)
- A quoted path with a space is read as one word, and a Windows program is read by its name: `CURL.EXE` is `curl`.

## 0.3.3 (2026-11-11)

- Windows paths with backslashes are read: the label of a file, the memory folders and the names of commands. Contributed by davidkinsler. (#11)

## 0.3.2 (2026-11-11)

- New option `background`: with `transparent` the map leaves its ground out and the surface shows through. (#10)

## 0.3.1 (2026-11-11)

- Fixed: a password in a web address could reach a label when the address was written in an unusual way. An address that can be read two ways now shows only its scheme. (#6)
- A hook's refusal shows the name of the tool it stopped; its first line shows only with the new option `hookReasons`.
- The word after a memory command shows only if it is listed in the new option `memorySubcommands`.
- A name in `memoryCommands` counts when it is the command itself or begins with it and `-`, `_` or `.`.
- More commands light Network: `rsync`, `nc`, `sftp`, `npm install`, `docker pull` and the like, also inside `$(…)`.
- Control characters are taken out of every label.

## 0.3.0 (2026-11-10)

- New option `layout`: `you-bottom` turns the ring so that you are at the bottom and the network at the top.

## 0.2.0 (2026-11-10)

- The route: a thin line joins the last stations in order.
- Spokes wear in with use, and two clock hands grow around a station while a call runs.
- Memory has a colour of its own; what a hook brought unasked is drawn and counted apart.
- A ring around the centre shows how full the context window is.
- A change of model rings at the centre and gets a row of its own.
- Subagents circle the Agents station.
- Calls that start together fly side by side; a fault leaves a dot until the next message; finished calls at one station fold into one row.
- A light palette and the option `theme`; with `auto` the map follows a light or a dark surface by itself.

## 0.1.0 (2026-11-09)

- The first version: a pane beside the chat with ten stations that light up as memory, files, shell, the network, the model, agents, skills and hooks are used.
- Labels in English, Russian, Spanish, French and German.
