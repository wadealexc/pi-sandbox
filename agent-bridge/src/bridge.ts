import * as net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// --- configuration --------------------------------------------------------
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
// Where pi runs. cwd is the workspace; HOME already points at /home/node in
// the image so ~/.pi/agent resolves to the bind-mounted agent dir.
const WORKDIR = process.env.WORKDIR ?? "/workspace";

// --- per-connection state -------------------------------------------------
interface ActiveConn {
    child: ChildProcessWithoutNullStreams;
    socket: net.Socket;
}
let active: ActiveConn | null = null;

function spawnAgent(cwd: string): ChildProcessWithoutNullStreams {
    return spawn("pi", ["--mode", "rpc", "--no-session"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
    });
}

function handleConnection(socket: net.Socket) {
    if (active) {
        socket.write(
            JSON.stringify({ type: "error", message: "Another client is connected." }) + "\n"
        );
        socket.end();
        return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
        child = spawnAgent(WORKDIR);
    } catch (err) {
        socket.write(
            JSON.stringify({ type: "error", message: `Failed to spawn pi: ${String(err)}` }) + "\n"
        );
        socket.end();
        return;
    }

    active = { child, socket };
    console.log(`[bridge] connection from ${socket.remoteAddress}:${socket.remotePort}; pi pid=${child.pid}`);

    // Forward outgoing JSONL (pi stdout) to the socket as-is.
    child.stdout.on("data", (chunk) => {
        if (!socket.destroyed) socket.write(chunk);
    });

    // stderr is for debugging the bridge, not part of the wire protocol.
    child.stderr.on("data", (chunk) => {
        process.stderr.write(`[pi stderr] ${chunk}`);
    });

    // Forward socket -> pi stdin as-is.
    socket.on("data", (chunk) => {
        if (!child.killed && child.stdin.writable) {
            child.stdin.write(chunk);
        }
    });

    const cleanup = (reason: string) => {
        if (!active) return;
        console.log(`[bridge] closing connection: ${reason}`);
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        if (!socket.destroyed) socket.end();
        active = null;
    };

    child.on("exit", (code, signal) => cleanup(`pi exited code=${code} signal=${signal}`));
    socket.on("close", () => cleanup("socket closed"));
    socket.on("error", (err) => cleanup(`socket error: ${err.message}`));
}

// --- server ---------------------------------------------------------------
const server = net.createServer((socket) => {
    handleConnection(socket);
});

server.on("error", (err) => {
    console.error(`[bridge] server error: ${err.message}`);
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    console.log(`[bridge] listening on ${HOST}:${PORT} (cwd=${WORKDIR})`);
});

// Graceful shutdown so `docker stop` is clean.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
        console.log(`[bridge] received ${sig}, shutting down`);
        if (active && !active.child.killed) active.child.kill("SIGTERM");
        server.close(() => process.exit(0));
    });
}
