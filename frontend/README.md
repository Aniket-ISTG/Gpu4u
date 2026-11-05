# Autonomous GPU Compute Router

A Next.js App Router prototype for interpreting GPU workload requests and browsing simulated GPU offers. The current implementation is an incremental Stage 0 foundation: Groq-powered workload analysis and a mock marketplace are available; real GPU provisioning and execution are not implemented.

## Current Features

- **Workload analyzer:** accepts natural-language compute requests and calls Groq from a server-only service. Groq is asked for strict JSON Schema output; the response is parsed and validated with Zod before it is returned.
- **Requirement provenance:** each interpreted field is marked `user_provided`, `estimated`, `default`, or `missing`. Unspecified critical values remain `null`, with clarification questions returned where appropriate. GPU count defaults to `1` and optimization defaults to `balanced`.
- **Mock marketplace:** provides 13 simulated GPU offers across RTX 3090, RTX 4090, A100 40GB, A100 80GB, H100, L4, L40S, and RTX A6000 models. Prices, availability, reliability, and performance values are illustrative mock data, not live provider data or benchmark claims.
- **Dashboard:** displays marketplace counts, offers, and a basic client-side recommendation using availability, VRAM, GPU count, hourly budget, and a weighted price/VRAM score. Marketplace data is labeled as simulated.

## Requirements

- Node.js with support for `--experimental-strip-types` for the built-in TypeScript test runner
- npm
- A Groq API key to use workload analysis

## Setup

Install dependencies from this directory (`EthMumbai/frontend`):

```bash
npm install
```

Create `.env.local` in this directory. Use `.env.example` as a template and provide your own Groq key:

```env
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=openai/gpt-oss-20b
```

`GROQ_MODEL` is optional; the default is `openai/gpt-oss-20b`. The configured model must support Groq structured outputs. Keep `.env.local` private and never commit or expose the API key in client-side code.

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The marketplace endpoint works without a Groq key. Submitting a workload requires a valid server-side `GROQ_API_KEY`.

## API

### `POST /api/workloads/analyze`

Request body:

```json
{
  "request": "Run Llama 3 8B inference with at least 16GB VRAM and a maximum budget of $2 per hour. Find the cheapest GPU."
}
```

The request must be valid JSON and `request` must contain 10 to 4000 characters. A successful response contains an `analysis` object with task type, model, minimum VRAM, GPU count, maximum hourly budget, optimization preference, CUDA requirement, field provenance, and clarification questions. Unspecified critical requirements are not silently populated with invented values.

The route returns a JSON `error` and a relevant HTTP status for invalid input, missing server configuration, timeouts, rate limits, provider errors, or malformed provider responses.

### `GET /api/marketplace`

Returns the mock offers in this envelope:

```json
{
  "success": true,
  "source": "mock",
  "offers": []
}
```

Each offer follows the `GPUOffer` contract in `lib/marketplace/types.ts` and includes an ID, provider, model, VRAM, GPU count, hourly price, availability, region, CUDA support, and optional mock reliability/performance scores.

## Project Layout

```text
app/
  api/marketplace/route.ts          Mock marketplace endpoint
  api/workloads/analyze/route.ts    Validated analyzer endpoint
  page.tsx                          Dashboard and current client-side ranking
components/
  WorkloadAnalyzer.tsx              Natural-language input and analysis display
data/
  mock-gpus.ts                      Simulated GPU catalog
lib/
  ai/groq.ts                        Server-only Groq integration
  marketplace/types.ts              Marketplace contracts
  marketplace/mock-provider.ts      Mock provider implementation
  validation/workload.schema.ts     Zod schema and provenance checks
tests/
  mock-marketplace.test.ts
  workload-schema.test.ts
```

## Validation

```bash
npm test
npm run lint
npm run build
```

The tests cover workload schema/provenance validation and mock offer data/provider behavior.

## Not Implemented Yet

- The analyzer result is not yet connected to the dashboard's manual workload filters.
- The current ranking is a small client-side dashboard calculation, not the planned modular routing engine. It does not yet support configurable cost/fastest/balanced weights or explain rejected offers.
- There is no job lifecycle, compute executor, simulated execution, or results dashboard.
- Aquanode and any other live marketplace provider are not integrated.
- There are no payments, blockchain features, or real GPU provisioning/execution.
- No database or persistent job store is configured.

These later features should be added incrementally after the corresponding stage is approved.
