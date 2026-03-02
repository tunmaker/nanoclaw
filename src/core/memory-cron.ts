/**
 * Nightly memory maintenance cron.
 * Runs independently of the container-based task-scheduler.
 *
 * Schedule:
 *   02:00 — memory consolidation
 */
import { CronExpressionParser } from 'cron-parser';
import { triggerConsolidation } from '../memory/memory-client.js';
import { TIMEZONE } from './config.js';
import { logger } from './logger.js';

function msUntilNext(cronExpr: string): number {
  const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
  return interval.next().getTime() - Date.now();
}

function scheduleNext(name: string, cronExpr: string, handler: () => Promise<void>): void {
  const delay = msUntilNext(cronExpr);
  logger.debug({ name, nextMs: delay }, 'Memory cron scheduled');

  setTimeout(async () => {
    try {
      logger.info({ name }, 'Memory cron starting');
      await handler();
      logger.info({ name }, 'Memory cron complete');
    } catch (err) {
      logger.error({ name, err }, 'Memory cron error');
    }
    // Reschedule for next occurrence
    scheduleNext(name, cronExpr, handler);
  }, delay);
}

export function startMemoryCron(): void {
  scheduleNext('memory-consolidation', '0 2 * * *', async () => {
    const result = await triggerConsolidation();
    logger.info({ result }, 'Memory consolidation complete');
  });

  logger.info('Memory cron started');
}
