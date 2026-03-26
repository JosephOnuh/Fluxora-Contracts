/**
 * Streams API - Database-backed stream management with filtering and pagination
 *
 * Provides RESTful endpoints for stream data with:
 * - Pagination support
 * - Filtering by status, address, date range
 * - Trust boundaries and authorization
 *
 * @openapi
 * /api/streams:
 *   get:
 *     summary: List all streams with filtering and pagination
 *     description: |
 *       Returns streams with support for filtering and pagination.
 *       All amount fields are serialized as decimal strings for precision.
 *     tags:
 *       - streams
 *     parameters:
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *           enum: [active, paused, completed, cancelled]
 *       - name: sender
 *         in: query
 *         schema:
 *           type: string
 *       - name: recipient
 *         in: query
 *         schema:
 *           type: string
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *       - name: offset
 *         in: query
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: List of streams with pagination metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 streams:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Stream'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 *       500:
 *         description: Internal server error
 *
 * /api/streams/{id}:
 *   get:
 *     summary: Get a stream by ID
 *     description: Returns a single stream by its identifier
 *     tags:
 *       - streams
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Stream details
 *       404:
 *         description: Stream not found
 *
 * components:
 *   schemas:
 *     Stream:
 *       type: object
 *       description: Streaming payment stream details
 *       properties:
 *         id:
 *           type: string
 *           description: Unique stream identifier
 *         sender_address:
 *           type: string
 *           description: Stellar account address of the sender
 *         recipient_address:
 *           type: string
 *           description: Stellar account address of the recipient
 *         amount:
 *           type: string
 *           description: Total streaming amount (decimal string)
 *         streamed_amount:
 *           type: string
 *           description: Amount streamed so far (decimal string)
 *         remaining_amount:
 *           type: string
 *           description: Remaining amount (decimal string)
 *         rate_per_second:
 *           type: string
 *           description: Streaming rate per second (decimal string)
 *         start_time:
 *           type: integer
 *           description: Unix timestamp when stream starts
 *         end_time:
 *           type: integer
 *           description: Unix timestamp when stream ends (0 if indefinite)
 *         status:
 *           type: string
 *           enum: [active, paused, completed, cancelled]
 *         contract_id:
 *           type: string
 *           description: Soroban contract ID
 *         transaction_hash:
 *           type: string
 *           description: Transaction hash that created the stream
 *         created_at:
 *           type: string
 *           description: When the record was created
 *         updated_at:
 *           type: string
 *           description: When the record was last updated
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { streamRepository } from "../db/repositories/streamRepository.js";
import { StreamFilter, StreamStatus } from "../db/types.js";
import {
  asyncHandler,
  notFound,
  validationError,
} from "../middleware/errorHandler.js";
import { info, debug } from "../utils/logger.js";

export const streamsRouter = Router();

/**
 * Default pagination values
 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Validate and parse query parameters
 */
function parseQueryParams(req: Request): {
  filter: StreamFilter;
  limit: number;
  offset: number;
} {
  const {
    status,
    sender,
    recipient,
    contract_id,
    start_from,
    start_to,
    end_from,
    end_to,
    limit,
    offset,
  } = req.query;

  // Validate status
  let validStatus: StreamStatus | undefined;
  if (status) {
    if (
      !["active", "paused", "completed", "cancelled"].includes(status as string)
    ) {
      throw validationError(
        "Invalid status value. Must be one of: active, paused, completed, cancelled",
      );
    }
    validStatus = status as StreamStatus;
  }

  // Validate addresses (basic check)
  const senderAddress = typeof sender === "string" ? sender : undefined;
  const recipientAddress =
    typeof recipient === "string" ? recipient : undefined;
  const contractId = typeof contract_id === "string" ? contract_id : undefined;

  // Parse timestamps
  const startTimeFrom = start_from
    ? parseInt(start_from as string, 10)
    : undefined;
  const startTimeTo = start_to ? parseInt(start_to as string, 10) : undefined;
  const endTimeFrom = end_from ? parseInt(end_from as string, 10) : undefined;
  const endTimeTo = end_to ? parseInt(end_to as string, 10) : undefined;

  // Validate timestamps
  if (startTimeFrom !== undefined && isNaN(startTimeFrom)) {
    throw validationError("start_from must be a valid integer");
  }
  if (startTimeTo !== undefined && isNaN(startTimeTo)) {
    throw validationError("start_to must be a valid integer");
  }
  if (endTimeFrom !== undefined && isNaN(endTimeFrom)) {
    throw validationError("end_from must be a valid integer");
  }
  if (endTimeTo !== undefined && isNaN(endTimeTo)) {
    throw validationError("end_to must be a valid integer");
  }

  // Parse pagination
  const parsedLimit = limit ? parseInt(limit as string, 10) : DEFAULT_LIMIT;
  const parsedOffset = offset ? parseInt(offset as string, 10) : 0;

  if (isNaN(parsedLimit) || parsedLimit < 1) {
    throw validationError("limit must be a positive integer");
  }
  if (isNaN(parsedOffset) || parsedOffset < 0) {
    throw validationError("offset must be a non-negative integer");
  }

  return {
    filter: {
      status: validStatus,
      sender_address: senderAddress,
      recipient_address: recipientAddress,
      contract_id: contractId,
      start_time_from: startTimeFrom,
      start_time_to: startTimeTo,
      end_time_from: endTimeFrom,
      end_time_to: endTimeTo,
    },
    limit: Math.min(parsedLimit, MAX_LIMIT),
    offset: parsedOffset,
  };
}

/**
 * GET /api/streams
 * List all streams with filtering and pagination
 *
 * Trust boundary: Public read-only access
 */
streamsRouter.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { filter, limit, offset } = parseQueryParams(req);
    const requestId = req.correlationId;

    debug("Listing streams", { filter, limit, offset, requestId });

    const result = streamRepository.find(filter, { limit, offset });

    info("Streams listed", {
      count: result.streams.length,
      total: result.total,
      requestId,
    });

    res.json({
      streams: result.streams,
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
      },
    });
  }),
);

/**
 * GET /api/streams/:id
 * Get a single stream by ID
 *
 * Trust boundary: Public read-only access
 */
streamsRouter.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const requestId = req.correlationId;

    debug("Fetching stream", { id, requestId });

    const stream = streamRepository.getById(id);

    if (!stream) {
      throw notFound("Stream", id);
    }

    res.json(stream);
  }),
);
