import {
  type AgentCollectorMessageParams,
  type AgentCollectorMessageResult,
  ErrorCodes,
  errorShape,
  validateAgentCollectorMessageParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { queueEmbeddedAgentMessageWithOutcomeAsync } from "../../agents/embedded-agent-runner/runs.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  isSubagentRunLive,
} from "../../agents/subagents/registry/subagent-registry-read.js";
import { withTranscriptWriteLock } from "../../config/sessions/session-accessor.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { loadSessionEntryReadOnly } from "../session-utils.js";
import { beginSessionMessagingInflight } from "./session-messaging-inflight.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function collectorMessageReceipt(activeMessagePosition: number): AgentCollectorMessageResult {
  return { delivered: true, sessionSeq: activeMessagePosition + 1 };
}

function isPersistedCollectorMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const message = value as { provenance?: unknown; role?: unknown };
  if (message.role !== "user" || !message.provenance || typeof message.provenance !== "object") {
    return false;
  }
  const provenance = message.provenance as { kind?: unknown; sourceTool?: unknown };
  return provenance.kind === "external_user" && provenance.sourceTool === "agent.collector.message";
}

export async function handleAgentCollectorMessage(params: {
  params: Record<string, unknown>;
  respond: RespondFn;
  context: GatewayRequestContext;
}) {
  if (
    !assertValidParams(
      params.params,
      validateAgentCollectorMessageParams,
      "agent.collector.message",
      params.respond,
    )
  ) {
    return;
  }
  const request = params.params as AgentCollectorMessageParams;
  const inflight = beginSessionMessagingInflight({
    context: params.context,
    idempotencyKey: request.idempotencyKey,
    method: "agent.collector.message",
    request: params,
  });
  if (inflight.kind === "handled") {
    await inflight.done;
    return;
  }
  const { respond } = inflight.owner;

  try {
    const loaded = loadSessionEntryReadOnly(request.sessionKey);
    const { canonicalKey, cfg, entry, storePath } = loaded;
    const sessionId = entry?.sessionId;
    const agentId = parseAgentSessionKey(canonicalKey)?.agentId;
    if (!entry || !sessionId || !agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${request.sessionKey}`),
      );
      return;
    }

    const target = {
      agentId,
      sessionId,
      sessionKey: canonicalKey,
      storePath,
    };
    const existing = await withTranscriptWriteLock(target, async (transcript) =>
      transcript.readMessageFacts({ idempotencyKeys: [request.idempotencyKey] }),
    );
    const existingMessage = existing.messagesByIdempotencyKey.get(request.idempotencyKey);
    const existingAnchor = existing.anchorsByIdempotencyKey.get(request.idempotencyKey);
    if (existingMessage) {
      if (!isPersistedCollectorMessage(existingMessage) || !existingAnchor) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `idempotency key is already used by another transcript message: ${request.idempotencyKey}`,
          ),
        );
        return;
      }
      respond(true, collectorMessageReceipt(existingAnchor.activeMessagePosition), undefined);
      return;
    }

    // A completed delivery remains replayable after the collector exits. This
    // returns durable history without granting a new write to an inactive run.
    const collectorRun = getLatestLiveSubagentRunByChildSessionKey(canonicalKey);
    const collectorContext = collectorRun ? getAgentRunContext(collectorRun.runId) : undefined;
    if (
      !collectorRun ||
      collectorRun.collect !== true ||
      collectorRun.execution.endedAt !== undefined ||
      collectorRun.collectorCompletion !== undefined ||
      !isSubagentRunLive(collectorRun) ||
      !collectorContext ||
      collectorContext.sessionKey !== canonicalKey ||
      collectorContext.sessionId !== sessionId
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `session is not an active collector run: ${request.sessionKey}`,
        ),
      );
      return;
    }

    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: request.message,
        idempotencyKey: request.idempotencyKey,
        provenance: {
          kind: "external_user",
          sourceTool: "agent.collector.message",
        },
        timestamp: Date.now(),
      },
      target: {
        ...target,
        config: cfg,
        expectedSessionId: sessionId,
        sessionEntry: entry,
      },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });
    const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, request.message, {
      steeringMode: "all",
      waitForTranscriptCommit: true,
      queueIdentity: request.idempotencyKey,
      userTurnTranscriptRecorder: recorder,
    });
    if (!outcome.queued || outcome.transcriptCommit === "unconfirmed") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          outcome.errorMessage ??
            (!outcome.queued
              ? `collector message delivery rejected: ${outcome.reason}`
              : "collector message transcript commit was not confirmed"),
          { retryable: true },
        ),
      );
      return;
    }
    const receipt = recorder.getAdmissionReceipt();
    if (!receipt) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "collector message transcript receipt was not recorded",
          {
            retryable: true,
          },
        ),
      );
      return;
    }
    respond(true, collectorMessageReceipt(receipt.activeMessagePosition), undefined);
  } catch (error) {
    inflight.owner.fail(error);
  } finally {
    inflight.owner.finish();
  }
}
