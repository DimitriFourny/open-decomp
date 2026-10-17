# Installation

The quickest supported path is a source checkout. A locally produced bundled `.tgz` can also be installed offline. The package is currently marked `private`; these instructions do not assume a published npm package.

## Requirements

- **Node.js 24 or newer** runs the CLI, MCP server, workers and JavaScript API. The repository pins Node 24.22.0 in `.node-version`.
- **Bun 1.4.3** installs dependencies and runs package scripts; it does not replace Node as the application runtime. The version is pinned in `.bun-version` and `package.json`.
- **macOS arm64 with Node 24.22.0** is the documented qualified host. Linux/WSL with Linux Node is intended but not yet host-qualified. Native Windows Node is not the supported Windows execution model. See [supported targets and hosts](README.md#status-and-supported-targets).

Mach-O ARM64, PE x86-64 and ELF x86-64 are analysis targets, not required execution hosts. The tool does not execute analyzed targets. No native compiler, sibling repository or external decompiler is required for ordinary analysis.

## From a source checkout

Run from the repository root:

```sh
bun install --frozen-lockfile
bun run build
bun run cli --help
```

`bun run build` emits the application and worker entrypoints under `dist/`. Run the source checkout's compiled CLI with `bun run cli`:

```sh
bun run cli functions /absolute/path/to/app --name main
bun run cli decompile /absolute/path/to/app --function main
```

Use an exact original/displayed name from the listing, including prefixes such as `_main`. For stripped binaries, select a listed function ID or address instead. See the [CLI guide](README.md#task-oriented-cli-and-persistent-cache) for selectors, output formats, exit codes and persistent cache behavior. The default sidecar is `<canonical binary path>.open-decomp/`; use `--cache PATH` when that location is not writable.

For local MCP from a built checkout:

```sh
bun run mcp --root /absolute/inputs --root /absolute/projects
```

Those directories must already exist. Authorize only the narrow input/project directories you need; no cwd/home root is implicit. See [MCP configuration](README.md#launch-and-configure-local-mcp) for host integration and [REMOTE.md](REMOTE.md) for authenticated HTTP.

## Install a packaged release offline

Obtain the produced `.tgz` **and its sibling `<tgz filename>.release.json`**, for example `open-decomp-0.1.0.tgz` and `open-decomp-0.1.0.tgz.release.json`. Keep them together. The schema-version-2 manifest binds archive SHA256, byte size, SHA1 shasum and SHA512 integrity, the `bun.lock` digest, Node/Bun versions, original source package metadata and archive inventory to the archive. Its `bun_pack` inventory records each file's path, size, mode and SHA256, plus bundled package names. A worktree-derived build is not necessarily a clean Git commit; no bit-identical cross-host build is promised.

With Node and Bun available, install in a separate application directory outside the source checkout. Substitute the actual archive path:

```sh
mkdir open-decomp-local
cd open-decomp-local
bun add --offline --ignore-scripts --production /absolute/path/open-decomp-0.1.0.tgz
```

Production dependencies, their WASM assets, compiled `dist/src` and compiled `dist/vendor/a64js` are bundled. The archive declares its bundled packages explicitly but omits source dependency/devDependency declarations, so Bun does not try to resolve those packages from the registry during offline installation; the release manifest retains the original source metadata and dependency versions. `bun add` creates the application's `package.json` if needed; do not run `bun init`, which sets up an unrelated development toolchain. Runtime installation requires neither a compiler, network fetch, fixture corpus nor development dependencies.

The installed binary is available under `node_modules/.bin`:

```sh
./node_modules/.bin/open-decomp functions /absolute/path/to/app --name main
./node_modules/.bin/open-decomp decompile /absolute/path/to/app --function main
./node_modules/.bin/open-decomp mcp start --root /absolute/inputs --root /absolute/projects
```

Once that directory is on your PATH, the command is simply `open-decomp`. Direct Node invocation avoids shell/PATH and shim differences:

```sh
node /absolute/app/node_modules/open-decomp/dist/src/cli/entry.js --help
```

Use the same installed package from a Node.js application with `import { openBinary } from 'open-decomp/api'`; see [API.md](API.md).

## Verification and troubleshooting

Keep the archive and manifest as the installation/update provenance record. Ordinary Bun installation does not itself validate the separate manifest. The [source-only installed-acceptance driver](README.md#developer-commands--source-checkout-only) performs that validation and an empty-cache offline closure check. A successful `--help` alone does not establish runtime closure: package import, worker startup, both decoders and all three demangler WASM paths must also work.

Do not fetch a registry copy with `bunx` or patch `node_modules` to compensate for a broken artifact. See [troubleshooting](README.md#troubleshooting) for import failures, worker limits, stale revisions, output artifacts and unsupported semantics.

For WSL, install and run inside the Linux distribution with Linux Node and POSIX paths, not `node.exe`. This remains intended-environment guidance, not a Linux/WSL qualification claim.

The application is licensed under [MIT](../LICENSE); dependencies retain their separate [third-party notices](THIRD-PARTY-NOTICES.md).
