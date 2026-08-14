import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_SERVER_CAPS,
  PROTOCOL_VERSION,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createCoreGatewayMethodDescriptors,
  listCoreAdvertisedGatewayMethodNames,
} from "../methods/core-descriptors.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  getAgentRunContext: vi.fn(),
  getCollectorRun: vi.fn(),
  isCollectorRunLive: vi.fn(),
  loadSessionEntryReadOnly: vi.fn(),
  queueCollectorMessage: vi.fn(),
}));

vi.mock("../../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/agent-run-registry.js")>()),
  getAgentRunContext: mocks.getAgentRunContext,
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent-runner/runs.js")>()),
  queueEmbeddedAgentMessageWithOutcomeAsync: mocks.queueCollectorMessage,
}));

vi.mock("../../agents/subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/subagents/registry/subagent-registry-read.js")
  >()),
  getLatestLiveSubagentRunByChildSessionKey: mocks.getCollectorRun,
  isSubagentRunLive: mocks.isCollectorRunLive,
}));

vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
}));

const { sessionMessagingHandlers } = await import("./sessions-messaging.js");

function makeFixture(dir: string) {
  const agentId = "main";
  const sessionId = "collector-session";
  const sessionKey = "agent:main:subagent:collector";
  const storePath = path.join(dir, "agents", agentId, "sessions", "sessions.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const entry = {
    sessionId,
    sessionFile: formatSqliteSessionFileMarker({ agentId, sessionId, storePath }),
    updatedAt: 1,
  };
  const cfg = { agents: { list: [{ id: agentId }] } };
  const collectorRun = {
    runId: "collector-run",
    childSessionKey: sessionKey,
    requesterSessionKey: "agent:main:main",
    collect: true,
    createdAt: 1,
    execution: { startedAt: 1 },
  };
  return { agentId, cfg, collectorRun, entry, sessionId, sessionKey, storePath };
}

type Fixture = ReturnType<typeof makeFixture>;

describe("agent.collector.message", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    mocks.getAgentRunContext.mockReset();
    mocks.getCollectorRun.mockReset();
    mocks.isCollectorRunLive.mockReset();
    mocks.loadSessionEntryReadOnly.mockReset();
    mocks.queueCollectorMessage.mockReset();
  });

  function createFixture() {
    const dir = tempDirs.make("openclaw-agent-collector-message-");
    return makeFixture(dir);
  }

  async function installFixture(fixture: Fixture) {
    await replaceSessionEntry(
      { storePath: fixture.storePath, sessionKey: fixture.sessionKey },
      fixture.entry,
    );
    mocks.loadSessionEntryReadOnly.mockReturnValue({
      canonicalKey: fixture.sessionKey,
      cfg: fixture.cfg,
      entry: fixture.entry,
      legacyKey: undefined,
      store: { [fixture.sessionKey]: fixture.entry },
      storeKeys: [fixture.sessionKey],
      storePath: fixture.storePath,
    });
    mocks.getCollectorRun.mockReturnValue(fixture.collectorRun);
    mocks.getAgentRunContext.mockReturnValue({
      sessionId: fixture.sessionId,
      sessionKey: fixture.sessionKey,
    });
    mocks.isCollectorRunLive.mockReturnValue(true);
    mocks.queueCollectorMessage.mockImplementation(async (_sessionId, _message, options) => {
      await options.userTurnTranscriptRecorder.persistApproved();
      return {
        gatewayHealth: "live",
        queued: true,
        sessionId: fixture.sessionId,
        target: "embedded_run",
      };
    });
  }

  function context(fixture: Fixture): GatewayRequestContext {
    return {
      dedupe: new Map(),
      getRuntimeConfig: () => fixture.cfg,
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestContext;
  }

  async function callHandler(
    fixture: Fixture,
    request: Record<string, unknown>,
    respond: RespondFn = vi.fn(),
  ) {
    await sessionMessagingHandlers["agent.collector.message"]?.({
      req: { id: "collector-message", method: "agent.collector.message", type: "req" },
      params: request,
      respond,
      context: context(fixture),
      client: null,
      isWebchatConnect: () => false,
    });
    return respond as ReturnType<typeof vi.fn>;
  }

  async function readMessages(fixture: Fixture): Promise<Array<Record<string, unknown>>> {
    return (
      await loadTranscriptEvents({
        agentId: fixture.agentId,
        sessionId: fixture.sessionId,
        sessionKey: fixture.sessionKey,
        storePath: fixture.storePath,
      })
    ).flatMap((event) => {
      const message = (event as { message?: unknown }).message;
      return message && typeof message === "object" ? [message as Record<string, unknown>] : [];
    });
  }

  it("admits schema-valid authenticated write delivery and rejects insufficient scope", async () => {
    const fixture = createFixture();
    await installFixture(fixture);
    const methodRegistry = createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors(sessionMessagingHandlers),
    );
    const dispatch = async (scopes: string[], idempotencyKey: string) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          id: `request-${idempotencyKey}`,
          method: "agent.collector.message",
          params: { sessionKey: fixture.sessionKey, message: "additional context", idempotencyKey },
          type: "req",
        },
        respond,
        client: {
          connId: `conn-${idempotencyKey}`,
          connect: {
            role: "operator",
            scopes,
            client: { id: "cli", version: "test", platform: "test", mode: "cli" },
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
          },
        } as Parameters<typeof handleGatewayRequest>[0]["client"],
        isWebchatConnect: () => false,
        context: context(fixture),
        methodRegistry,
      });
      return respond;
    };

    expect(await dispatch(["operator.write"], "authenticated-1")).toHaveBeenCalledWith(
      true,
      { delivered: true, sessionSeq: 1 },
      undefined,
    );
    expect(await dispatch(["operator.read"], "unauthorized-1")).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    const invalid = await callHandler(fixture, {
      sessionKey: fixture.sessionKey,
      idempotencyKey: "missing-message",
    });
    expect(invalid).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("returns the durable active-message sequence only after transcript persistence", async () => {
    const fixture = createFixture();
    await installFixture(fixture);
    await persistSessionTranscriptTurn(
      {
        agentId: fixture.agentId,
        sessionId: fixture.sessionId,
        sessionKey: fixture.sessionKey,
        storePath: fixture.storePath,
      },
      {
        messages: [
          {
            idempotencyLookup: "scan",
            message: { role: "user", content: "initial prompt", idempotencyKey: "initial" },
          },
        ],
      },
    );
    const queueEntered = createDeferred();
    const releaseQueue = createDeferred();
    mocks.queueCollectorMessage.mockImplementation(async (_sessionId, _message, options) => {
      queueEntered.resolve();
      await releaseQueue.promise;
      await options.userTurnTranscriptRecorder.persistApproved();
      return {
        gatewayHealth: "live",
        queued: true,
        sessionId: fixture.sessionId,
        target: "embedded_run",
      };
    });
    const respond = vi.fn();

    const delivery = callHandler(
      fixture,
      {
        sessionKey: fixture.sessionKey,
        message: "durable follow-up",
        idempotencyKey: "durable-1",
      },
      respond,
    );
    await queueEntered.promise;
    expect(respond).not.toHaveBeenCalled();
    expect(await readMessages(fixture)).toEqual([
      expect.objectContaining({ content: "initial prompt" }),
    ]);
    expect(mocks.queueCollectorMessage).toHaveBeenCalledWith(
      fixture.sessionId,
      "durable follow-up",
      expect.objectContaining({
        queueIdentity: "durable-1",
        steeringMode: "all",
        waitForTranscriptCommit: true,
      }),
    );
    releaseQueue.resolve();
    await delivery;

    expect(respond).toHaveBeenCalledWith(true, { delivered: true, sessionSeq: 2 }, undefined);
    expect(await readMessages(fixture)).toEqual([
      expect.objectContaining({ content: "initial prompt" }),
      expect.objectContaining({
        content: "durable follow-up",
        idempotencyKey: "durable-1",
        provenance: {
          kind: "external_user",
          sourceTool: "agent.collector.message",
        },
        role: "user",
      }),
    ]);
  });

  it("replays the persisted receipt without injecting a duplicate user message", async () => {
    const fixture = createFixture();
    await installFixture(fixture);
    const request = {
      sessionKey: fixture.sessionKey,
      message: "deliver once",
      idempotencyKey: "redelivery-1",
    };

    const first = await callHandler(fixture, request);
    mocks.getCollectorRun.mockReturnValue(null);
    mocks.isCollectorRunLive.mockReturnValue(false);
    const replay = await callHandler(fixture, request);

    expect(first).toHaveBeenCalledWith(true, { delivered: true, sessionSeq: 1 }, undefined);
    expect(replay).toHaveBeenCalledWith(true, { delivered: true, sessionSeq: 1 }, undefined);
    expect(mocks.queueCollectorMessage).toHaveBeenCalledTimes(1);
    expect(await readMessages(fixture)).toEqual([
      expect.objectContaining({
        content: "deliver once",
        idempotencyKey: "redelivery-1",
        provenance: {
          kind: "external_user",
          sourceTool: "agent.collector.message",
        },
      }),
    ]);
  });

  it("rejects inactive and non-collector sessions before prompt injection", async () => {
    const fixture = createFixture();
    await installFixture(fixture);
    mocks.getCollectorRun.mockReturnValue({ ...fixture.collectorRun, collect: false });
    const nonCollector = await callHandler(fixture, {
      sessionKey: fixture.sessionKey,
      message: "not a collector",
      idempotencyKey: "non-collector",
    });
    mocks.getCollectorRun.mockReturnValue(fixture.collectorRun);
    mocks.isCollectorRunLive.mockReturnValue(false);
    const inactive = await callHandler(fixture, {
      sessionKey: fixture.sessionKey,
      message: "collector already ended",
      idempotencyKey: "inactive",
    });
    mocks.isCollectorRunLive.mockReturnValue(true);
    mocks.getAgentRunContext.mockReturnValue({
      sessionId: "another-generation",
      sessionKey: fixture.sessionKey,
    });
    const rebound = await callHandler(fixture, {
      sessionKey: fixture.sessionKey,
      message: "collector identity changed",
      idempotencyKey: "rebound",
    });

    for (const respond of [nonCollector, inactive, rebound]) {
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("not an active collector run"),
        }),
      );
    }
    expect(mocks.queueCollectorMessage).not.toHaveBeenCalled();
  });

  it("advertises the additive method and capability without a protocol version bump", () => {
    const descriptors = createCoreGatewayMethodDescriptors(sessionMessagingHandlers);
    const collectorDescriptor = descriptors.find(({ name }) => name === "agent.collector.message");

    expect(collectorDescriptor).toMatchObject({ scope: "operator.write", since: "2026.8" });
    expect(listCoreAdvertisedGatewayMethodNames()).toContain("agent.collector.message");
    expect(GATEWAY_SERVER_CAPS.AGENT_COLLECTOR_MESSAGE).toBe("agent.collector.message");
    expect(PROTOCOL_VERSION).toBe(4);
  });
});
