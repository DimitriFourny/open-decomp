# Authenticated MCP over HTTP

F02 serves the existing Open Decomp tools and artifact resources over the pinned official MCP SDK 2.3.1 `createMcpHandler` HTTP implementation, with native HTTP/TLS CLI entry points. It shares the homemade analysis/presentation pipeline and F01's C-like/Python-like emitter selection; it does not introduce a separate public analysis protocol. Current macOS compiled investigation/restart evidence is recorded below. This is separate from frozen first-release stdio qualification: no new extension npm artifact has yet been built/installed, and earlier archive results do not qualify this checkout.

## Start and provision

Use Node 24 (verification used 24.22.0). The development package declares a separate HTTP command; a newly produced artifact must receive its own installed acceptance before it is qualified:

```sh
open-decomp-mcp-http --config /absolute/private/open-decomp-http.json
```

The development/compiled entry is `src/mcp/http/entry.ts` / `dist/src/mcp/http/entry.js`; from the checkout use `npm run mcp:http -- --config /absolute/private/open-decomp-http.json`. `--help` prints usage. No roots, tokens or worker modules are accepted as network arguments. The actual installed local stdio binary is **`open-decomp`**, not `open-decomp-mcp`; no alias is provided. Its compiled entry remains `dist/src/mcp/stdio.js`.

Provision an existing, private project **parent directory** for each principal, and separate existing directories containing operator-approved input binaries. Clients choose absolute project paths strictly beneath their principal's project root. Creating a project requires its immediate parent to exist; the server does not recursively create arbitrary directories. Clients may import only existing files beneath that principal's input roots. There is no upload, URL import, symbol-server download, target execution, target-library loading, plugin endpoint or arbitrary file resource endpoint.

Generate a fresh 32-byte random secret for each identity, encode it as unpadded base64url (43 characters), and distribute it privately out of band. For example, run this locally in a private terminal, not in server logs:

```sh
node --input-type=module -e 'import {randomBytes,createHash} from "node:crypto"; const token=randomBytes(32).toString("base64url"); console.log(JSON.stringify({token,token_sha256:createHash("sha256").update(token).digest("hex")}));'
```

Store only the lowercase SHA256 digest in the server configuration. Keep the actual bearer secret in the client's credential store. The example digest below is deliberately not a usable provisioned credential; replace it with your generated digest before deployment.

```json
{
  "host": "127.0.0.1",
  "port": 3000,
  "principals": [
    {
      "id": "analyst-a",
      "token_sha256": "REPLACE_WITH_64_LOWERCASE_SHA256_HEX_CHARACTERS",
      "project_root": "/srv/open-decomp/projects/analyst-a",
      "input_roots": ["/srv/open-decomp/inputs"],
      "max_workers": 2,
      "max_queued": 8,
      "max_requests": 8,
      "requests_per_minute": 120,
      "work_admissions_per_minute": 60,
      "max_work_admissions": 10000,
      "max_budget": {
        "instructions": 10000,
        "blocks": 10000,
        "ir_nodes": 100000,
        "work": 1000000,
        "deadline_ms": 30000,
        "output_bytes": 1048576
      }
    }
  ]
}
```

Configuration is strict JSON: unknown keys are rejected, as are relative paths, duplicate principal IDs or duplicate token hashes. The config file must be a regular file, at most 256 KiB. Between 1 and 32 principals are accepted; IDs are 1–64 ASCII letters/digits/underscore/hyphen and start with a letter or digit. Each principal needs one project root and 1–32 input roots. Roots are canonicalized before startup. Project roots must be pairwise disjoint and must not overlap **any** principal's input roots, including their owner's. Shared input roots are permitted. Ancestor, descendant, equality and symlink-alias overlaps are rejected.

Use OS permissions to prevent clients or unrelated local users from changing configuration, TLS material, roots, symlinks or project files. Canonical/symlink containment uses the same helper as worker admission, not a second remote path convention. This is host authorization, not a race-proof filesystem sandbox against an attacker who can rewrite the host filesystem. Do not share a project directory between server processes or change an identity's root ownership to another principal without an explicit administrative data migration.

## Binding, TLS and rebinding protection

The default endpoint is `http://127.0.0.1:3000/mcp`. `host` must be an IP literal; DNS names are not resolved as bind addresses. `127.0.0.0/8` and `::1` are treated as loopback. Non-loopback binding is rejected without **native TLS**. For example, add/change these fields in the complete configuration above, retaining its provisioned `principals` array:

```json
{
  "host": "0.0.0.0",
  "port": 8443,
  "allowed_hosts": ["analysis.example.org:8443"],
  "allowed_origins": [],
  "tls": {
    "cert_path": "/absolute/private/server-chain.pem",
    "key_path": "/absolute/private/server-key.pem"
  }
}
```

The second fragment illustrates the remote fields, not a deployable configuration by itself. The certificate and private key must be regular local PEM files, bounded to 256 KiB and 64 KiB respectively. TLS minimum version is 1.2. Supply a valid chain and hostname/SAN for clients; configure a private CA explicitly where appropriate. Never disable client certificate verification. The test-only key/certificate under `test/mcp/` are public fixtures and must never be deployed.

`allowed_hosts`, when supplied, contains 1–32 exact canonical HTTP authorities: lowercase hostname/IP and port when nondefault, IPv6 in brackets. Without it, only the actual bound authority is allowed (including an OS-selected port when `port: 0`). A wildcard bind normally needs an explicit advertised host allowlist. There are no wildcard Host rules. Path must be exactly `/mcp`; no query strings, alternate escaping or absolute-form request targets. Host and Origin checks apply before dispatch to **every** method, including OPTIONS, GET, DELETE and malformed Expect requests. Duplicate headers, malicious/opaque Origins such as `null`, and disallowed Hosts are rejected.

`allowed_origins` defaults to `[]`: no Origin-bearing requests are accepted. Up to 32 exact canonical HTTP(S) origins may be configured; off-loopback origins must be HTTPS. An absent Origin is allowed for an authenticated non-browser client. This endpoint does not add CORS headers or an unauthenticated preflight exemption; configuring an Origin allowlist is not a claim of general browser/CORS support. Forwarded/X-Forwarded headers never establish identity, scheme, client address or authority. A proxy must preserve the configured public Host and must not strip an untrusted Origin. Off-loopback TLS termination only at a proxy is insufficient: the native listener must also use TLS. Loopback proxy hops remain part of the operator's trusted local boundary.

## Authentication and identity

Every request must carry `Authorization: Bearer SECRET`, including protocol discovery and control methods. Secrets are 43–128 ASCII base64url characters; provision at least 256 bits of randomness. The server hashes the bounded secret and compares the digest in constant time against **every** configured principal hash. Token entropy cannot be inferred from a stored hash; operators must not hash passwords or predictable strings. Unknown/absent credentials receive HTTP 401. Credentials are not forwarded into SDK request headers or logged.

This is private, operator-provisioned, out-of-band bearer authentication. It is **not** an OAuth authorization server, OAuth discovery flow, login service, token issuer or SSO implementation. Configure the official SDK HTTP client's request headers explicitly:

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'investigator', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(
  new URL('https://analysis.example.org:8443/mcp'),
  { requestInit: { headers: { authorization: `Bearer ${secretFromCredentialStore}` } } },
));
// Existing tools/call and resources/read workflows are unchanged.
```

Each principal owns a separate persistent `QueryService` and worker pool. A guessed project ID, durable job ID or artifact URI does not open another principal's project. Reopen is authorized against the principal's canonical private root; artifact resources contain published project/revision/artifact identities, never filesystem paths. Application-supplied annotation `author` and `origin` remain provenance assertions, not authenticated login identities.

The SDK constructs fresh protocol instances per HTTP exchange and supports its stateless legacy fallback. GET/DELETE session operations are not offered; there is no session cookie or transport session identity to steal, persist or use for authorization. Subscription streams are disabled. Ordinary tools, progress, durable `analysis_status` / `analysis_cancel` and paged artifacts remain the supported investigation surface.

Rotate credentials by replacing a principal's hash and restarting. Existing projects retain identity because the same principal keeps the same private directory. There is no live reload, token expiry/refresh or revocation database; stopping the listener is the immediate revocation boundary. A token's holder has all tool rights within that configured principal, not separate read/write roles.

## Disconnect, work ownership and shutdown

The server checks whether the exchange is aborted before and after asynchronous path authorization. Ownership transfers to the principal at **validated, authorized service dispatch**. This is not an invented atomic "durably committed" point: a disconnect can race subsequent worker admission or persistence. After dispatch, transport loss, HTTP deadline, output failure or SDK request cancellation does not automatically cancel service work, including `wait: true`. `analysis_cancel` is the explicit durable cancellation tool.

A waiting/disconnected HTTP request releases its network/request slot. Dispatched service work retains a separate bounded work slot until it settles; status/cancel/close have a separate bounded control lane so a disconnected waiting job does not prevent its owner from inspecting or cancelling it. Default asynchronous requests return a durable job handle and then leave execution to the bounded project queue. Job handles can be used after reconnect under the same bearer identity. Prefer default asynchronous admission for long operations and save acknowledged project/job IDs. If an acknowledgement was lost, inspect the saved project, revisions, annotations and known jobs; do not automatically replay imports or mutations. `wait: true` has the same lost-acknowledgement ambiguity and does not guarantee that the result survives a disconnected client.

The root embedding API exports `startHttpServer` / `HttpServerHandle` and `loadHttpConfig` / `HttpConfig`. `startHttpServer(config, workerRuntime?)` returns a handle with `{ url: URL, close(): Promise<void> }`; `loadHttpConfig(absolutePath)` reads/validates local JSON. The URL reports the actual bound port, useful for embedding/tests. `close()` is idempotent: it stops admission/listening, aborts SDK exchanges, destroys owned sockets, waits for dispatched bounded service calls, then cancels remaining asynchronous/queued jobs and closes **all** principal services/workers even if another close fails. In-flight calls may take their configured job deadline plus bounded worker shutdown/recovery time to settle. SIGINT/SIGTERM use this same close path. No worker survives intentionally as a daemon. Interrupted project state remains durable and can be reopened after restart; unfinished imports require the existing explicit repair flow.

The optional embedding-only `workerRuntime` is restricted to existing trusted `entry_point`, `exec_argv` and `cancel_grace_ms` worker options. It is never read from JSON, tool arguments or network metadata. Custom entry points are trusted host code with the server account's privileges; they are not an untrusted plugin feature. Configured roots, worker counts and queue bounds remain authoritative. The normal entry always uses the packaged real worker.

## Resource and operational boundaries

All limits are per process. Deploy behind OS/container memory, CPU, process, disk and connection quotas with a least-privilege account. Workers provide fault containment, not an OS sandbox; no claim is made that malformed native data cannot exploit Node or a decoder dependency. Static analysis consumes target data only. Back up project directories, monitor disk use externally and retire/archive projects administratively. There is no HTTP delete/upload or automatic retention policy.

| Setting | Default | Accepted range / meaning |
| --- | --- | --- |
| `port` | 3000 | 0–65535; zero selects a free local port |
| `limits.max_connections` | 64 | 1–1024, all TCP sockets including idle/TLS handshakes |
| `limits.max_requests` | 32 | 1–256 concurrent admitted HTTP requests globally |
| `limits.requests_per_minute` | 600 | 1–100000 global token-bucket capacity/refill per minute, includes unauthenticated requests |
| `limits.header_bytes` | 8192 | 1024–32768, native parser cap |
| `limits.header_count` | 32 | 8–128, duplicate headers also rejected |
| `limits.request_timeout_ms` | 60000 | 100–600000, absolute request/output deadline and maximum TCP connection lifetime |
| `limits.body_timeout_ms` | 10000 | 100–60000, absolute body deadline; also native header/handshake timeout |
| `limits.idle_timeout_ms` | 10000 | 100–60000, socket inactivity and keep-alive bound; even a silent waiting computation can lose its exchange |
| principal `max_workers` | 2 | 1–8 persistent project workers; idle open projects count |
| principal `max_queued` | 8 | 0–64 queued jobs per worker, in addition to its running job |
| principal `max_requests` | 8 | 1–8 concurrent HTTP exchanges; separately bounds active service work/artifact reads and active control calls |
| principal `requests_per_minute` | 120 | 1–10000 token-bucket capacity/refill per minute |
| principal `work_admissions_per_minute` | 60 | 1–1000 token-bucket capacity/refill per minute for dispatched tools other than status/cancel/close |
| principal `max_work_admissions` | 10000 | 1–1000000 total work dispatch attempts per server lifetime; failures after dispatch consume admission too |

Buckets start full and refill continuously; they are not fixed calendar-minute counters. Only configured principals allocate rate state: unknown tokens/IPs cannot create an unbounded limiter map. Global limits prevent multiplying all capacity by the principal count. Per-principal work count, queue capacity and request budgets bound detached work, not merely live HTTP exchanges. Artifact reads are separately bounded by active work and HTTP rates and do not create durable jobs. `max_work_admissions` bounds lifetime growth attempts but is not a byte quota or persisted billing ledger; restarting resets it. Disk quotas are still required.

`max_budget` uses the existing core budget fields/defaults shown above. It is a ceiling, not a rewritten tool budget: requests above it fail before dispatch, and omissions still mean the normal core defaults. Configure clients explicitly when lowering ceilings below those defaults. Allowed maxima are instructions 1,000,000; blocks 100,000; IR nodes 10,000,000; work 100,000,000; deadline 300,000 ms; output 16,777,216 bytes. Numeric minima are 1 except output's 1024 bytes. Budgets and emitter options retain their existing cache identities.

Transport bodies are at most 2 MiB, UTF-8 JSON, one message rather than a JSON batch, nesting at most 64 levels and at most 100,000 traversed values. String request IDs/progress tokens are at most 1024 UTF-8 bytes; numeric IDs/tokens must be safe integers. Compressed bodies and Expect/100-continue are not supported. Tool/resource result envelopes retain their existing 2 MiB ceiling and mutation delivery preflight; HTTP adds at most 16 KiB for SDK/SSE framing. No budget is silently clamped and no mutation is automatically retried. Network writes wait for the native write callback before reading another output chunk. Slow/non-draining peers are disconnected by inactivity/absolute deadlines, and each connection serves at most 100 requests. Reconnect normally after that bound; a lost mutation response still requires reconciliation.

HTTP rejections use bounded status-only messages: 400 malformed/duplicate/ID, 401 credentials, 403 Host/Origin, 404 endpoint, 405 method, 408 body timeout, 413 body/complexity/output size, 415 media/encoding/Expect, 429 rate/concurrency, 431 headers, 503 shutdown. Native parser errors may close a connection before an application response. Tool authorization/work-limit failures use the existing bounded MCP tool-error shape; errors do not expose another principal's paths, data or credentials. A rejected oversized output may close an already-started response rather than deliver a replacement error.

## Verification scope

The recorded combined macOS run under Node 24.22.0 passed strict typecheck, **730/730 tests** (six suites, zero skipped) and build. `test/mcp/http.test.ts` covers official-SDK workflows for Mach-O/ARM64 and PE/x86-64, private project/job/artifact isolation, trusted-CA native TLS, canonical root overlap/escape denial, mandatory per-method authentication, Host/Origin rejection, malformed/oversized input, quotas, deterministic real-worker gates for disconnect/cancellation/shutdown, and raw slow-peer/socket lifecycle cases. The public TLS fixture is test-only, never deployment material.

Separate actual **compiled CLI** workflows used the normal packaged-layout `dist` entries, real default workers and official SDK clients over stdio, HTTP and HTTPS. Each transport imported symbol-bearing Mach-O ARM64 and stripped PE x64, found a real arithmetic function, emitted C-like and Python-like to distinct artifacts, compared mapped instruction sets, fetched/hash-checked complete artifact pages, hit Python-like cache, applied an annotation at revision 2→3 and recomputed, then closed. Restarting the entire server process recovered the same project/revision/Python-like cache artifact. HTTP(S) additionally rejected missing credentials (401), hostile Origin (403), and cross-principal project/artifact access. HTTPS used an explicitly trusted test CA via `NODE_EXTRA_CA_CERTS`; certificate verification was never disabled.

The **14 JSONL records** are `.local/extension-verification/macos-stdio-http-https.jsonl`, SHA256 `52462b1b29e8318f45e43f9afb0f776668b7170719f15746b65cea32ffaadab6`. Artifact-paging request rates were raised in the test configuration; this was not a throughput benchmark. [RELEASE-VERIFICATION.md](RELEASE-VERIFICATION.md) records harness corrections and frozen artifact provenance separately. No new extension artifact has been built/installed, Windows-host qualification remains blocked by a focused compiled stalled-output failure, and neither this evidence nor PE analysis on macOS constitutes Windows/release completion.
