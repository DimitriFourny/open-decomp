# Open Decomp

Analyze native binaries and decompile individual functions without source code or executing the target. Open Decomp combines instruction decoders with its own typed-IR decompiler to produce C-like or Python-like pseudocode, with SQLite-backed projects and cached analysis. Supports Mach-O ARM64, PE x86-64 and ELF x86-64 through a CLI, MCP for AI clients, and a JavaScript/TypeScript API.

## Quick setup

Requires **Node.js 24+** and **Bun 1.4.3**. From a checkout:

```sh
bun install --frozen-lockfile
bun run build
```

See [installation](docs/INSTALLATION.md) for runtime/host requirements and installing a packaged release.

## Try it on a binary

```sh
# Find a function in your binary
bun run cli functions ./app --name main

# Decompile using the exact name shown above
bun run cli decompile ./app --function main

# Decompile every function into a directory an LLM agent can grep
bun run cli export ./app --out ./app-decompiled
```

Names may include a prefix such as `_main`; use the name shown in the function list. You can also select a listed function with `--id ID` or `--address va:0x...` when symbols are stripped. Add `--language python-like` to change the output dialect, or `--json` for structured results.

Projects are saved next to the binary in `app.open-decomp/`; repeated commands reuse the imported image and cached analysis. Output is pseudocode, not recovered original source.

Set defaults once (cache root, analysis cache, decompile/export language, view, jobs) in an optional `~/.config/open-decomp/settings.json` (or `$XDG_CONFIG_HOME/open-decomp/settings.json`, or `--settings PATH`); flags always win. See [Settings file](docs/README.md#settings-file) and `open-decomp settings`.

## Documentation

- [CLI, settings file, MCP setup and troubleshooting](docs/README.md)
- [JavaScript / TypeScript API](docs/API.md)
- [Remote MCP and security](docs/REMOTE.md)
- [Core contracts](docs/CORE.md), [fixtures](docs/FIXTURES.md) and [performance](docs/PERFORMANCE.md)

## License

[MIT](LICENSE). Bundled dependencies retain their own licenses; see [third-party notices](docs/THIRD-PARTY-NOTICES.md).
