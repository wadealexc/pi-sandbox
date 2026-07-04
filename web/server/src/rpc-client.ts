import * as net from "node:net";

/**
 * Long-lived JSONL-RPC client to the agent bridge over TCP.
 *
 * The agent runs `pi --mode rpc`, which speaks strict JSONL over stdin/stdout:
 * commands in (one JSON object per line), responses + events out. See
 * docs/rpc.md. The bridge just forwards bytes over a TCP socket.
 *
 * Responses carry an `id` and resolve the matching pending request. Events
 * have no `id` and go to the registered event listener.
 *
 * Reading splits on "\n" only — NOT readline, which also splits on
 * U+2028 / U+2029 (valid inside JSON strings).
 */
export class RpcClient {
    private socket: net.Socket | null = null;
    private buffer = "";
    private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private eventCb: ((event: any) => void) | null = null;
    private nextId = 1;
    private connected = false;
    private shouldReconnect = true;
    private reconnectTimer: NodeJS.Timeout | null = null;

    constructor(private addr: string) {}

    /** Register the single event listener (the active SSE handler). */
    onEvent(cb: (event: any) => void): void {
        this.eventCb = cb;
    }

    /** Open the connection. Resolves once the socket is connected. */
    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const [host, portStr] = this.addr.split(":");
            const port = Number(portStr);
            const socket = net.createConnection({ host, port }, () => {
                this.connected = true;
                console.log(`[rpc] connected to ${this.addr}`);
                resolve();
            });
            this.socket = socket;
            socket.setNoDelay(true);
            socket.on("data", (chunk) => this.onData(chunk));
            socket.on("error", (err) => this.onDisconnect(`socket error: ${err.message}`, err));
            socket.on("close", () => this.onDisconnect("socket closed"));
        });
    }

    /** Send a command, assigning an id, and await its response. */
    send(command: Record<string, any>): Promise<any> {
        if (!this.connected || !this.socket || this.socket.destroyed) {
            return Promise.reject(new Error("RPC client not connected"));
        }
        const id = String(this.nextId++);
        const line = JSON.stringify({ id, ...command }) + "\n";
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`RPC timeout: ${command.type}`));
            }, 30000);
            const entry = this.pending.get(id);
            if (entry) clearTimeout(timer);
            this.pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
            this.socket!.write(line, (err) => {
                if (err) {
                    this.pending.delete(id);
                    reject(new Error(`RPC write failed: ${err.message}`));
                }
            });
        });
    }

    private onData(chunk: Buffer | string): void {
        this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        while (true) {
            const idx = this.buffer.indexOf("\n");
            if (idx === -1) break;
            let line = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (line.length === 0) continue;
            this.handleLine(line);
        }
    }

    private handleLine(line: string): void {
        let obj: any;
        try {
            obj = JSON.parse(line);
        } catch {
            console.error(`[rpc] non-JSON line: ${line.slice(0, 200)}`);
            return;
        }
        if (obj && typeof obj.id === "string" && this.pending.has(obj.id)) {
            // Response to a pending request.
            const entry = this.pending.get(obj.id)!;
            this.pending.delete(obj.id);
            if (obj.success === false) {
                entry.reject(new Error(obj.error ?? "RPC command failed"));
            } else {
                entry.resolve(obj);
            }
        } else if (obj && typeof obj.type === "string") {
            // Event (no id) — hand to the listener if any.
            if (this.eventCb) this.eventCb(obj);
        } else {
            // Unmatched response or malformed object.
            console.error(`[rpc] unmatched line: ${line.slice(0, 200)}`);
        }
    }

    private onDisconnect(reason: string, err?: Error): void {
        if (!this.connected) return;
        this.connected = false;
        this.socket = null;
        console.error(`[rpc] disconnected: ${reason}`);
        // Reject anything still pending.
        for (const [, entry] of this.pending) entry.reject(err ?? new Error(`RPC disconnected: ${reason}`));
        this.pending.clear();
        // Reconnect after a short delay. Keep it simple for v0.
        if (this.shouldReconnect && !this.reconnectTimer) {
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                this.connect().catch((e) => console.error(`[rpc] reconnect failed: ${e.message}`));
            }, 2000);
        }
    }

    /** Stop reconnecting and close. */
    dispose(): void {
        this.shouldReconnect = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.socket?.destroy();
    }
}
