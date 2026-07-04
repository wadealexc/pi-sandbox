import { Router, type Request, type Response } from "express";
import type { RpcClient } from "../rpc-client.js";

const router = Router();

// Single chat turn at a time. The active SSE response, if any.
let streamingRes: Response | null = null;

function isStreaming(): boolean {
    return streamingRes !== null && !streamingRes.writableEnded;
}

/** Map an RPC event to the v0 SSE wire format, or null to drop it. */
function mapEvent(event: any): Record<string, any> | null {
    switch (event.type) {
        case "message_update": {
            const d = event.assistantMessageEvent;
            if (d && d.type === "text_delta" && typeof d.delta === "string") {
                return { kind: "text_delta", delta: d.delta };
            }
            if (d && d.type === "text_start") {
                return { kind: "text_start" };
            }
            return null;
        }
        case "tool_execution_start":
            return {
                kind: "tool_start",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
            };
        case "tool_execution_end":
            return {
                kind: "tool_end",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                result: event.result,
                isError: !!event.isError,
            };
        case "agent_end":
            return { kind: "agent_end" };
        default:
            return null;
    }
}

export function makeChatRouter(rpc: RpcClient): Router {
    /** POST /chat — send a prompt; stream events back as SSE until agent_end. */
    router.post("/chat", async (req: Request, res: Response) => {
        const { message } = req.body ?? {};
        if (typeof message !== "string" || message.length === 0) {
            res.status(400).json({ error: "Body must be { message: string }." });
            return;
        }
        if (isStreaming()) {
            res.status(409).json({ error: "Agent is already streaming." });
            return;
        }

        // Open SSE.
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        streamingRes = res;

        // Relay events until agent_end (or socket close).
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            rpc.onEvent(() => {});
            streamingRes = null;
            if (!res.writableEnded) res.end();
        };

        rpc.onEvent((event) => {
            if (finished) return;
            const mapped = mapEvent(event);
            if (!mapped) return;
            res.write(`data: ${JSON.stringify(mapped)}\n\n`);
            if (mapped.kind === "agent_end") {
                finish();
            }
        });

        // Client disconnects mid-stream (response connection closed): stop
        // relaying, but the agent keeps running (we can't cheaply abort it
        // in v0). Just close our end. NOTE: listen on res, not req — req's
        // `close` fires when the request body is consumed, not on disconnect.
        res.on("close", () => {
            if (!finished) {
                console.log("[chat] client disconnected mid-stream");
                finish();
            }
        });

        // Send the prompt. If it's rejected before acceptance, end the SSE
        // with an error frame. Errors after acceptance come through events.
        try {
            await rpc.send({ type: "prompt", message });
        } catch (err) {
            res.write(`data: ${JSON.stringify({ kind: "error", error: String(err) })}\n\n`);
            finish();
        }
    });

    /** POST /chat/clear — start a fresh session (refuses while streaming). */
    router.post("/chat/clear", async (_req: Request, res: Response) => {
        if (isStreaming()) {
            res.status(409).json({ error: "Can't clear while streaming." });
            return;
        }
        try {
            await rpc.send({ type: "new_session" });
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    /** POST /chat/stop — abort the current agent run (no-op if not streaming). */
    router.post("/chat/stop", async (_req: Request, res: Response) => {
        if (!isStreaming()) {
            res.status(409).json({ error: "Not currently streaming." });
            return;
        }
        try {
            // abort returns a response once the abort is acknowledged; the
            // trailing agent_end still flows to the active SSE handler.
            await rpc.send({ type: "abort" });
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    return router;
}

export default makeChatRouter;
