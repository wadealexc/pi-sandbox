import express from "express";
import * as path from "node:path";
import filesRouter from "./routes/files.js";
import { makeChatRouter } from "./routes/chat.js";
import { RpcClient } from "./rpc-client.js";
import { WORKSPACE } from "./workspace.js";

const PORT = Number(process.env.WEB_PORT ?? 8090);
const HOST = process.env.WEB_HOST ?? "0.0.0.0";
const AGENT_ADDR = process.env.AGENT_ADDR ?? "agent:8080";

const app = express();
app.use(express.json());

// --- agent RPC client (long-lived) ---------------------------------------
const rpc = new RpcClient(AGENT_ADDR);
rpc.connect().catch((e) => console.error(`[web] rpc connect failed: ${e.message}`));

// --- health ---------------------------------------------------------------
app.get("/health", (_req, res) => {
    res.json({ ok: true, workspace: WORKSPACE });
});

// --- file routes ----------------------------------------------------------
app.use(filesRouter);

// --- chat routes ----------------------------------------------------------
app.use(makeChatRouter(rpc));

// --- static frontend ------------------------------------------------------
// Served from /public (built frontend). The dir may not exist yet during
// early testing; that's fine — only `/api`-style routes above respond.
const publicDir = path.resolve(process.env.PUBLIC_DIR ?? "public");
app.use(express.static(publicDir));

app.listen(PORT, HOST, () => {
    console.log(`[web] listening on http://${HOST}:${PORT} (workspace=${WORKSPACE})`);
});

// Graceful shutdown so `docker stop` is clean.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
        console.log(`[web] received ${sig}, shutting down`);
        rpc.dispose();
        process.exit(0);
    });
}
