# Dark Lab

![Dark Lab](preview.png)

A pixel-art lab at night. Rain on the windows, your spaces as experiment bays, a context meter, and a strip of recent agent activity.

## Install

```sh
./install.sh
```

Or point your agent at this folder.

## Notes

- The context meter works with Claude Code, Codex, pi and Devin. It reads each agent's local session log and never touches the network.
- Herdr doesn't know Devin yet, so `install.sh` adds a small `programs.json` entry for it (only if you don't have that file).
- Made on macOS.
