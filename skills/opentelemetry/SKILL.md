---
name: opentelemetry
description: Use when adding, changing or reviewing OpenTelemetry tracing, metrics or logs in a service — installing the SDK or auto-instrumentation in Node.js, Python or Go, naming spans and attributes, propagating context across HTTP calls and queues, recording errors, choosing sampling, exporting over OTLP to a Collector — or when traces are broken into pieces, spans are missing, metric cardinality or telemetry cost explodes, or personal data appears in telemetry.
metadata:
  title: OpenTelemetry
  frameworks: OpenTelemetry
  summary: The SDK started once before the app, libraries on the API only, a named resource, semantic-convention names, low-cardinality span names and metric attributes, context propagated across every hop, errors recorded once, OTLP to a Collector configured by OTEL_* variables, and no personal data in attributes.
---

# OpenTelemetry

OpenTelemetry (OTel) is a vendor-neutral API, SDK and wire protocol (OTLP) for traces, metrics and logs. Most of its value comes from three things: every signal names the service it came from, one trace follows a request across every process it touches, and names follow the shared semantic conventions so any backend can read them. Most bugs come from breaking one of those. The SDK starts after the libraries it should patch, so their spans are missing. A queue hop drops the context, so one request becomes two traces. A user ID in a span name or metric attribute makes every query slow and the bill large. Get startup, resource, propagation and naming right first. Custom spans and metrics are then a few lines each.

## Principles

1. **Instrument through the API, configure through the SDK.** Application and library code imports only the API (`@opentelemetry/api`, `opentelemetry-api`, `go.opentelemetry.io/otel`). One entry point owns the SDK, exporters and sampling. Without an SDK the API is a no-op, so libraries and tests stay safe.
2. **Start the SDK once, before anything else.** Auto-instrumentation patches modules when they load. Load it first, through `node --import`, `opentelemetry-instrument` or the top of `main`, never inside a request handler or a module that may load late.
3. **Name the service.** Every process sets `service.name`, `service.version` and `deployment.environment.name`. Telemetry without a resource cannot be attributed to anything.
4. **Use semantic conventions before inventing names.** `http.request.method`, `http.route`, `db.system.name`, `messaging.system`, `gen_ai.request.model` and the rest already exist and backends understand them. Prefix custom attributes with your domain (`app.order.id`), never with `otel.` or a convention namespace.
5. **Keep names low-cardinality, details in attributes.** A span name identifies a kind of operation (`GET /users/{id}`, `orders.checkout`), never one instance of it (`GET /users/4812`). IDs, sizes and outcomes go in span attributes. Metric attributes are a small fixed set of values, because every distinct combination is a separate time series.
6. **Propagate context across every hop.** W3C `traceparent` (and `baggage`, if you use it) travels on every outgoing HTTP or gRPC call and every queued message. Inject when producing, extract when consuming. A batch consumer links to the producer spans instead of picking one as the parent.
7. **Prefer auto-instrumentation, add spans for your own work.** Libraries for HTTP, databases, queues and LLM SDKs already emit conventional spans. Add a manual span only for a unit of work worth timing or failing on its own, such as a business operation, a retry loop or an external call no library covers. Never add one per function.
8. **Record an error once, where it is handled.** The span whose operation failed calls `recordException` and sets status `ERROR` with a short message. Don't mark spans `OK` by hand, and don't record the same exception on every parent it passes through.
9. **Choose the signal by the question.** Metrics answer "how many and how fast, overall" cheaply, at any traffic. Traces answer "what happened to this request". Logs hold details neither carries. Correlate logs with the active `trace_id` and `span_id` instead of copying span data into log lines.
10. **Export OTLP to a Collector, configured by environment.** Services send OTLP to a local or sidecar Collector. The Collector batches, retries, redacts, tail-samples and routes to vendors. Endpoints, headers, sampling and the resource come from standard `OTEL_*` variables, so the same build runs everywhere and the vendor can change without a deploy.
11. **Sample on purpose.** Use `parentbased_traceidratio` so a trace is kept or dropped whole. Keep errors and slow traces with tail sampling in the Collector. Metrics are never sampled, so rates and percentiles come from metrics, not from sampled traces.
12. **Treat telemetry as data that leaves the system.** No passwords, tokens, emails, names, full request or response bodies, prompts or query strings with secrets in attributes, events or logs. Redact again in the Collector as a second line of defence.
13. **Flush before exit, test with in-memory exporters.** Short-lived processes (serverless handlers, CLIs, jobs) call `shutdown()` or `forceFlush()` before returning. Tests assert on spans through an in-memory exporter, never by sending telemetry to a real backend.

## Quick reference

| Concern | Do | Instead of |
| --- | --- | --- |
| Startup | `node --import ./instrumentation.mjs server.mjs`; `opentelemetry-instrument python app.py`; SDK set up at the top of Go `main` | initializing the SDK after `express`, `pg` or `requests` are already imported |
| Dependencies | API in libraries; SDK, exporters and instrumentations only in the app | a library that bundles and starts its own SDK |
| Resource | `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES=service.version=1.4.2,deployment.environment.name=prod` | `unknown_service:node` in every trace |
| Span names | `GET /users/{id}`, `orders.checkout`, `SELECT orders` | `GET /users/4812`, `handleRequest`, `doStuff` |
| Attributes | semantic conventions, then `app.*` for your domain | `userId`, `myapp_status`, attributes shadowing `http.*` |
| Span kind | `SERVER` for incoming, `CLIENT` for outgoing, `PRODUCER` / `CONSUMER` for messages, `INTERNAL` otherwise | every span `INTERNAL`, so service maps stay empty |
| Errors | `span.recordException(err); span.setStatus({ code: SpanStatusCode.ERROR, message })` once | logging the stack and leaving the span `UNSET`; recording it on every parent |
| Propagation | default W3C `tracecontext,baggage`; inject into message headers, extract in the consumer | a new trace on each side of a queue; custom `X-Request-Id` as the only link |
| Metrics | counters for counts, histograms for durations in seconds, attributes from a fixed set | a gauge per user, attributes holding IDs or URLs, durations in mixed units |
| Logs | your logger plus the OTel logs bridge, so records carry `trace_id` and `span_id` | `console.log` with no correlation; a log line per span |
| Export | OTLP (`http/protobuf` or `grpc`) to a Collector via `OTEL_EXPORTER_OTLP_ENDPOINT` | a vendor SDK in each service; endpoint and API keys hard-coded |
| Processing | `BatchSpanProcessor` (the SDK default) | `SimpleSpanProcessor` in production, which exports synchronously per span |
| Sampling | `OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG=0.1`; tail sampling in the Collector | 100% in production by accident; a child dropping spans its parent kept |
| Personal data | IDs and enums; Collector `redaction` / `attributes` processors as backup | emails, tokens, prompts, bodies in attributes |
| Tests | `InMemorySpanExporter` with a `SimpleSpanProcessor`; reset between tests | real OTLP traffic from CI; no assertions on telemetry at all |
| Exit | `await sdk.shutdown()` on `SIGTERM` and at the end of short-lived handlers | a function that returns before the batch is exported |

## Example: Node.js startup

```ts
// instrumentation.ts: loaded with `node --import ./dist/instrumentation.js dist/server.js`.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

// Service name, endpoint, headers and sampler come from OTEL_* environment variables.
const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
  instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
});

sdk.start();
process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
```

```sh
OTEL_SERVICE_NAME=checkout-api
OTEL_RESOURCE_ATTRIBUTES=service.version=1.4.2,deployment.environment.name=production
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

## Example: a manual span and a metric

```ts
// orders/checkout.ts: application code imports only the API.
import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('checkout');
const meter = metrics.getMeter('checkout');
const duration = meter.createHistogram('app.checkout.duration', { unit: 's' });

export async function checkout(order: Order) {
  return tracer.startActiveSpan('orders.checkout', async (span) => {
    const start = performance.now();
    let outcome = 'ok';
    span.setAttribute('app.order.id', order.id);
    span.setAttribute('app.order.item_count', order.items.length);
    try {
      return await chargeAndReserve(order); // HTTP and DB calls inside get child spans automatically
    } catch (err) {
      outcome = 'error';
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'checkout failed' });
      throw err;
    } finally {
      duration.record((performance.now() - start) / 1000, { 'app.checkout.outcome': outcome, 'app.payment.method': order.paymentMethod });
      span.end();
    }
  });
}
```

The order ID goes on the span, where one value per request is expected. The histogram only gets the outcome and the payment method, which have a handful of values each.

## Example: context across a queue

```ts
import { context, propagation, SpanKind, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('orders');

// Producer: write the current context into the message headers.
export function publishOrder(queue: Queue, order: Order) {
  tracer.startActiveSpan('orders publish', { kind: SpanKind.PRODUCER }, (span) => {
    const headers: Record<string, string> = {};
    propagation.inject(context.active(), headers);
    queue.send({ body: order, headers });
    span.end();
  });
}

// Consumer: continue the producer's trace.
export function onMessage(message: Message) {
  const parent = propagation.extract(context.active(), message.headers);
  tracer.startActiveSpan('orders process', { kind: SpanKind.CONSUMER }, parent, async (span) => {
    try { await handle(message.body); } finally { span.end(); }
  });
}
```

Check the instrumentation for your client first. Kafka, RabbitMQ, SQS and others often do this already. For a batch, start one consumer span and pass each message's extracted span context as a `link`.

## Python

```sh
pip install opentelemetry-distro opentelemetry-exporter-otlp
opentelemetry-bootstrap -a install   # installs instrumentations for the libraries it finds
OTEL_SERVICE_NAME=checkout-api opentelemetry-instrument python app.py
```

```python
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

tracer = trace.get_tracer(__name__)

def checkout(order):
    with tracer.start_as_current_span("orders.checkout") as span:
        span.set_attribute("app.order.id", order.id)
        try:
            return charge_and_reserve(order)
        except Exception as exc:
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR, "checkout failed"))
            raise
```

`start_as_current_span` records and re-raises exceptions by default. The explicit form is shown to make the rule visible. Gunicorn and uWSGI fork workers, so start the SDK in a post-fork hook, not in the master process.

## Testing telemetry

```ts
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

const exporter = new InMemorySpanExporter();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();

afterEach(() => exporter.reset());

it('marks a failed checkout as an error', async () => {
  await expect(checkout(declinedOrder)).rejects.toThrow();
  const [span] = exporter.getFinishedSpans().filter((s) => s.name === 'orders.checkout');
  expect(span.status.code).toBe(SpanStatusCode.ERROR);
  expect(span.attributes['app.order.id']).toBe(declinedOrder.id);
});
```

Assert on the spans and attributes dashboards and alerts depend on. A renamed span silently breaks them.

## Common mistakes

- **SDK started too late.** It is imported after the HTTP framework or database driver, so their spans never appear. Load it with `--import` or the language's auto-instrumentation launcher.
- **Broken traces.** A thread pool, queue, `setTimeout` without the context manager, or a hand-rolled HTTP client drops the context, and the backend shows many single-span traces. Find where the `traceparent` header stops.
- **High-cardinality names.** Raw URLs as span names, or user IDs, request IDs or full paths as metric attributes. Use the route template for spans, and keep IDs on spans only.
- **Duplicate spans.** Two instrumentations for the same library (auto plus a framework plugin), or manual spans wrapping calls that are already instrumented.
- **Spans never ended.** A missing `span.end()` on an early return or thrown error. Use `startActiveSpan` with `finally`, or a context manager.
- **Lost telemetry on exit.** Serverless handlers and jobs return before the batch processor exports. Flush or shut down first.
- **Vendor lock-in through the back door.** Vendor-specific attribute names or SDKs in application code. Keep vendor details in the Collector config.
- **Secrets in telemetry.** Auto-instrumentation can capture headers, SQL or LLM prompts when configured to. Check which options are on before enabling them in production.

## References

- [OpenTelemetry docs](https://opentelemetry.io/docs/): concepts, signals and language guides
- [Semantic conventions](https://opentelemetry.io/docs/specs/semconv/): HTTP, database, messaging, RPC, GenAI and resource attributes
- [SDK environment variables](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/): `OTEL_*` configuration
- [JavaScript](https://opentelemetry.io/docs/languages/js/), [Python](https://opentelemetry.io/docs/languages/python/) and [Go](https://opentelemetry.io/docs/languages/go/) guides
- [Context propagation](https://opentelemetry.io/docs/concepts/context-propagation/): W3C Trace Context and baggage
- [Sampling](https://opentelemetry.io/docs/concepts/sampling/): head and tail sampling
- [Collector](https://opentelemetry.io/docs/collector/): receivers, processors, exporters and deployment patterns
- [Handling sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/): what not to collect and how to redact it
