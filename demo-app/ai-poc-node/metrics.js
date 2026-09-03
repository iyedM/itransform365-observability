/**
 * Module réutilisable — Métriques OpenTelemetry pour les agents IA.
 * Complète le tracing existant avec de vraies métriques Prometheus
 * agrégeables : latence (p95/p99), taux d'erreur, tokens consommés.
 *
 * Contrairement aux attributs de trace (visibles trace par trace),
 * ces métriques passent par le Meter (pas le Tracer) et alimentent
 * directement Prometheus via le Collector - permettent des dashboards
 * avec histogram_quantile(), rate(), etc. comme pour demo-api en Phase 1.
 */

const { MeterProvider, PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");

function setupMetrics(serviceName) {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";

  const exporter = new OTLPMetricExporter({ url: otlpEndpoint });
  const metricReader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 5000, // export toutes les 5s vers le Collector
  });

  const meterProvider = new MeterProvider({
    resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: serviceName }),
    readers: [metricReader],
  });

  const meter = meterProvider.getMeter("aizo-agent-metrics");

  // Compteur de requêtes, avec labels status (success/error) et agent
  const requestCounter = meter.createCounter("agent_requests_total", {
    description: "Nombre total de requêtes traitées par un agent",
  });

  // Histogramme de latence en millisecondes - permet p50/p95/p99 via histogram_quantile()
  const latencyHistogram = meter.createHistogram("agent_request_duration_milliseconds", {
    description: "Durée des requêtes traitées par un agent",
    unit: "ms",
  });

  // Histogramme de tokens consommés, séparé prompt/completion
  const tokenHistogram = meter.createHistogram("agent_tokens_consumed", {
    description: "Nombre de tokens consommés par requête",
  });

  return { meterProvider, requestCounter, latencyHistogram, tokenHistogram };
}

/**
 * Enregistre les métriques d'un appel agent terminé.
 * @param {object} metrics - objet retourné par setupMetrics()
 * @param {string} agentName - nom de l'agent (label pour filtrer par agent)
 * @param {number} durationMs - durée de l'appel en millisecondes
 * @param {"success"|"error"} status - statut de l'appel
 * @param {object} [tokens] - { prompt, completion } si disponible
 */
function recordAgentCall(metrics, agentName, durationMs, status, tokens = null) {
  const labels = { agent: agentName, status };

  metrics.requestCounter.add(1, labels);
  metrics.latencyHistogram.record(durationMs, { agent: agentName });

  if (tokens) {
    if (tokens.prompt) {
      metrics.tokenHistogram.record(tokens.prompt, { agent: agentName, type: "prompt" });
    }
    if (tokens.completion) {
      metrics.tokenHistogram.record(tokens.completion, { agent: agentName, type: "completion" });
    }
  }
}

module.exports = { setupMetrics, recordAgentCall };
