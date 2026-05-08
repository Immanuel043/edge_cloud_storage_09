import type { Consumer, Producer } from 'kafkajs';
import logger from './logger';

/**
 * Wires KafkaJS consumer/producer instrumentation events to the Winston
 * logger so real Kafka problems (request timeouts, consumer crashes,
 * rebalances) surface as structured log lines instead of getting buried
 * under `kafka.logger()` noise.
 *
 * The benign `[RequestQueue] Response without match` warning is intentionally
 * NOT filtered — it acts as a canary signal. If timeouts or crashes start
 * pairing with it, we'll see the real symptoms in these listeners.
 *
 * Call this AFTER `kafka.consumer()` and `kafka.producer()` are constructed,
 * but ideally BEFORE `.connect()` so the connect/group_join events are caught.
 */
export function wireConsumerInstrumentation(consumer: Consumer): void {
  const e = consumer.events;

  consumer.on(e.CONNECT, () => {
    logger.info('[kafka] consumer.connect');
  });

  consumer.on(e.DISCONNECT, () => {
    logger.info('[kafka] consumer.disconnect');
  });

  consumer.on(e.GROUP_JOIN, (event) => {
    const p = event.payload as { groupId?: string; memberId?: string; leaderId?: string };
    logger.info(
      `[kafka] consumer.group_join groupId=${p.groupId ?? '?'} memberId=${p.memberId ?? '?'} leader=${p.leaderId === p.memberId}`
    );
  });

  consumer.on(e.REBALANCING, () => {
    logger.warn('[kafka] consumer.rebalancing');
  });

  consumer.on(e.CRASH, (event) => {
    const p = event.payload as { groupId?: string; error?: { message?: string }; restart?: boolean };
    logger.error(
      `[kafka] consumer.crash groupId=${p.groupId ?? '?'} restart=${p.restart ?? false} error=${p.error?.message ?? '?'}`
    );
  });

  consumer.on(e.REQUEST_TIMEOUT, (event) => {
    const p = event.payload as { broker?: string; correlationId?: number; apiName?: string };
    logger.warn(
      `[kafka] consumer.request_timeout broker=${p.broker ?? '?'} api=${p.apiName ?? '?'} correlationId=${p.correlationId ?? '?'}`
    );
  });

  logger.info('[kafka] consumer instrumentation wired');
}

export function wireProducerInstrumentation(producer: Producer): void {
  const e = producer.events;

  producer.on(e.CONNECT, () => {
    logger.info('[kafka] producer.connect');
  });

  producer.on(e.DISCONNECT, () => {
    logger.info('[kafka] producer.disconnect');
  });

  producer.on(e.REQUEST_TIMEOUT, (event) => {
    const p = event.payload as { broker?: string; correlationId?: number; apiName?: string };
    logger.warn(
      `[kafka] producer.request_timeout broker=${p.broker ?? '?'} api=${p.apiName ?? '?'} correlationId=${p.correlationId ?? '?'}`
    );
  });

  logger.info('[kafka] producer instrumentation wired');
}
