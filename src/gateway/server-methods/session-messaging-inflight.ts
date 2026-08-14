import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { formatForLog } from "../ws-log.js";
import { resolveGatewayInflightRequest, type GatewayInflightResult } from "./inflight.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type SessionMessagingInflightOwner = {
  respond: RespondFn;
  fail: (error: unknown) => void;
  finish: () => void;
};

export function beginSessionMessagingInflight(params: {
  context: GatewayRequestContext;
  idempotencyKey: string;
  method: "agent.collector.message" | "sessions.steer";
  request: { respond: RespondFn };
}):
  | { kind: "handled"; done: Promise<void> }
  | { kind: "owner"; owner: SessionMessagingInflightOwner } {
  const originalRespond = params.request.respond;
  const dedupeKey = `${params.method}:${params.idempotencyKey}`;
  const inflight = resolveGatewayInflightRequest({
    context: params.context,
    dedupeKey,
    idempotencyKey: params.idempotencyKey,
    respond: originalRespond,
  });
  if (inflight.kind === "handled") {
    return inflight;
  }

  let resolveResult: (result: GatewayInflightResult) => void = () => {};
  const work = new Promise<GatewayInflightResult>((resolve) => {
    resolveResult = resolve;
  });
  let settled = false;
  const settle = (result: GatewayInflightResult): boolean => {
    if (settled) {
      return false;
    }
    settled = true;
    resolveResult(result);
    return true;
  };
  inflight.inflightMap.set(dedupeKey, work);
  const respond: RespondFn = (ok, payload, error, meta) => {
    settle({
      ok,
      ...(payload !== undefined ? { payload } : {}),
      ...(error ? { error } : {}),
      ...(meta ? { meta } : {}),
    });
    if (meta === undefined) {
      originalRespond(ok, payload, error);
      return;
    }
    originalRespond(ok, payload, error, meta);
  };

  return {
    kind: "owner",
    owner: {
      respond,
      fail: (error) => {
        const responseError = errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error), {
          retryable: true,
        });
        if (settle({ ok: false, error: responseError })) {
          originalRespond(false, undefined, responseError);
        }
      },
      finish: () => {
        if (!settled) {
          const error = errorShape(
            ErrorCodes.UNAVAILABLE,
            `${params.method} ended before producing a response`,
            { retryable: true },
          );
          settle({ ok: false, error });
          originalRespond(false, undefined, error);
        }
        if (inflight.inflightMap.get(dedupeKey) === work) {
          inflight.inflightMap.delete(dedupeKey);
        }
      },
    },
  };
}
