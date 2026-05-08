import client from 'prom-client';

/**
 * Prometheus metrics registry for the web-service.
 *
 * Default Node.js process metrics (CPU, memory, event-loop lag, GC, etc.)
 * are auto-registered. Custom counters/gauges/histograms can be added
 * here and exported for use in the rest of the codebase.
 *
 * Mounted at GET /metrics in app.ts. Scraped by Prometheus per
 * infrastructure/monitoring/prometheus.yml ('web-service' job).
 */

export const register = new client.Registry();

register.setDefaultLabels({ service: 'web-service' });

client.collectDefaultMetrics({ register });

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'web_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const httpRequestsTotal = new client.Counter({
  name: 'web_http_requests_total',
  help: 'Count of HTTP requests',
  labelNames: ['method', 'route', 'status'],
});

export const websocketConnectionsActive = new client.Gauge({
  name: 'web_websocket_connections_active',
  help: 'Currently connected Socket.IO clients',
});

export const kafkaPublishesTotal = new client.Counter({
  name: 'web_kafka_publishes_total',
  help: 'Total Kafka publishes from web-service',
  labelNames: ['topic', 'result'],
});

register.registerMetric(httpRequestDurationSeconds);
register.registerMetric(httpRequestsTotal);
register.registerMetric(websocketConnectionsActive);
register.registerMetric(kafkaPublishesTotal);
