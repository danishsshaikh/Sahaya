# Sahaya LLM routing

`callLLM` and `streamLLM` optionally install a server-only AI SDK language-model
adapter. Feature routes, parsers, tools and the SDK result/stream API stay intact.
`LLM_ROUTER_ENABLED=false` (or unset) preserves the existing path. No router
credentials, configuration or new provider picker are exposed to Settings.

## Configuration

Use ignored runtime environment configuration, never `NEXT_PUBLIC_*`:

| Key | Meaning / default |
| --- | --- |
| `LLM_ROUTER_ENABLED` | Exact `true` enables routing; default disabled |
| `LLM_ROUTER_PRIMARY_MODEL` | Required `provider:model` identifier; e.g. `openai:nvidia/nemotron-3-ultra-550b-a55b` |
| `LLM_ROUTER_PRIMARY_BASE_URL` | Required OpenAI-compatible endpoint |
| `LLM_ROUTER_PRIMARY_API_KEY` | Server-only credential; absent means no Authorization header |
| `LLM_ROUTER_PRIMARY_LOCAL` | Exact `true` asserts operator-controlled local infrastructure; default false |
| `LLM_ROUTER_FALLBACK_MODEL` | Required local Gemma `provider:model` identifier |
| `LLM_ROUTER_FALLBACK_BASE_URL` | Required deployment-configured compatible endpoint |
| `LLM_ROUTER_FALLBACK_API_KEY` | Optional server-only credential |
| `LLM_ROUTER_FALLBACK_LOCAL` | Explicit local attestation, default false |
| `LLM_ROUTER_INITIAL_TIMEOUT_MS` | 60000; legacy per-attempt default used when role-specific timeouts are unset |
| `LLM_ROUTER_PRIMARY_TIMEOUT_MS` | Optional primary attempt deadline; defaults to `LLM_ROUTER_INITIAL_TIMEOUT_MS` |
| `LLM_ROUTER_FALLBACK_TIMEOUT_MS` | Optional fallback attempt deadline; defaults to `LLM_ROUTER_INITIAL_TIMEOUT_MS` |
| `LLM_ROUTER_STREAM_INITIAL_CHUNK_TIMEOUT_MS` | 45000; from attempt start through first meaningful provider part |
| `LLM_ROUTER_TOTAL_TIMEOUT_MS` | 180000; shared budget across primary, fallback and tool steps |
| `LLM_ROUTER_CIRCUIT_FAILURE_THRESHOLD` | 3 consecutive qualifying primary failures |
| `LLM_ROUTER_CIRCUIT_COOLDOWN_MS` | 30000 before one recovery probe |

Keep the existing managed LLM and `DEFAULT_MODEL` configuration: upstream model
resolution and LLM availability checks still run before the router. Stage routes
still resolve normally, but enabling this router deliberately overrides their
final transport selection. Routing adds no Image/Video/ASR/PDF/Web Search capability.
Endpoint order can be reversed through configuration. Both endpoints must support
the requests used by the deployment (including tools/vision where needed).

## Behavior

Each call attempts primary once, then fallback once for network errors, router or
provider timeouts, HTTP 408/429/5xx. No SDK transport retries are added. HTTP
400/401/403/404, unknown errors, malformed requests, validation failures and user
cancellation do not trigger failover. Retry-After never delays the current request.
Configured content-validation retries remain separate. Raw provider exceptions
are replaced by safe classified causes; prompts, URLs, keys and responses are not
included in router logs or errors.

Non-streaming attempt deadlines include response generation, not just connection.
Primary and fallback can use different attempt budgets so a fast primary failure
does not force the local fallback to die at the same short deadline. Streaming
first-part establishment is capped by both the role-specific attempt budget and
`LLM_ROUTER_STREAM_INITIAL_CHUNK_TIMEOUT_MS`; after stream commitment the total
deadline remains active. Fallback receives only the remaining total budget, so
primary time plus fallback time never exceeds `LLM_ROUTER_TOTAL_TIMEOUT_MS`.
Slow models may need larger deployment-specific budgets.

Only the inert provider `stream-start` header is held back. Every other non-error
event commits selection, including reasoning/tool starts, response metadata and
raw events. Errors before commitment can discard that one header and use fallback.
After commitment, errors propagate through the ordinary SDK stream error path;
providers are never spliced. A successful generation or committed stream pins
selection across subsequent tool steps, avoiding replay of executed tools.
The existing compatible-provider reasoning extraction separates `<think>` content
from text. For NVIDIA Nemotron-compatible structured requests without tools, the
router adds `chat_template_kwargs.enable_thinking=false` centrally to reduce
unneeded reasoning latency and token use. Tool-bearing Nemotron requests keep
their existing request shape, and non-Nemotron endpoints, including local Gemma,
are not given Nemotron-specific fields.

The circuit is in-memory and process-local (not shared across workers). CLOSED
attempts primary. Qualifying failures open it at the threshold. OPEN bypasses
primary. After cooldown, HALF_OPEN admits one probe while other calls use fallback.
A completed successful primary response closes it; a failed probe reopens it.
Cancellation and non-qualifying errors do not count toward the threshold. An
inconclusive probe releases its lease and waits another cooldown. Configuration
changes reset circuit state. Usage is attributed to the actual serving endpoint;
successful multi-step calls retain aggregate accounting.

Optional final wrapper argument: `{ externalAllowed: false, requestId?: string }`.
This selects only an endpoint with its corresponding `_LOCAL=true`; absent an
eligible endpoint (or with routing disabled), it fails closed. Locality is an
operator assertion, not inferred from a hostname. No automatic sensitive-data
classification is performed. Use opaque request IDs and fixed operation labels,
never private content. Logs contain only IDs, operation, provider/model identifiers,
selection role, fallback reason, circuit state, status, attempt timeout budget,
latency and time to first part.

All tests use fake models or mocked HTTP. Live endpoint compatibility and latency
must be verified separately in an isolated deployment. No deployment is performed
by the local implementation or test suite.
