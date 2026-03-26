/**
 * Health check endpoints
 *
 * Provides operational health status including:
 * - Basic liveness check
 * - Database connectivity
 * - Metrics snapshot
 *
 * @openapi
 * /health:
 *   get:
 *     summary: Basic health check
 *     description: Returns service status and basic liveness
 *     tags:
 *       - health
 *     responses:
 *       200:
 *         description: Service is healthy
 *
 * /health/ready:
 *   get:
 *     summary: Readiness check
 *     description: Returns detailed readiness status including DB and metrics
 *     tags:
 *       - health
 *     responses:
 *       200:
 *         description: Service is ready
 *       503:
 *         description: Service is not ready
 *
 * /health/metrics:
 *   get:
 *     summary: Metrics snapshot
 *     description: Returns current metrics for monitoring
 *     tags:
 *       - health
 *     responses:
 *       200:
 *         description: Metrics data
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { checkDatabaseHealth } from "../db/connection.js";
import { getHealthMetrics } from "../metrics/index.js";

export const healthRouter = Router();

/**
 * Basic liveness check - service is running
 */
healthRouter.get("/", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "fluxora-backend",
    timestamp: new Date().toISOString(),
  });
});

/**
 * Readiness check - service can handle requests
 */
healthRouter.get("/ready", (_req: Request, res: Response) => {
  const dbHealth = checkDatabaseHealth();
  const health = getHealthMetrics();

  const isReady = dbHealth.healthy && health.healthy;

  res.status(isReady ? 200 : 503).json({
    status: isReady ? "ready" : "not_ready",
    timestamp: new Date().toISOString(),
    checks: {
      database: dbHealth,
      metrics: health.checks,
    },
  });
});

/**
 * Metrics endpoint for monitoring
 */
healthRouter.get("/metrics", (_req: Request, res: Response) => {
  const health = getHealthMetrics();

  res.json({
    timestamp: new Date().toISOString(),
    ...health,
  });
});
