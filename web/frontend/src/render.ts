// Transcript renderer: builds and updates DOM nodes for user messages,
// streamed assistant text, and tool-call rows.

const TRUNCATE_LINES = 30;

interface PendingTool {
    row: HTMLElement;
    argsEl: HTMLElement;
    resultEl: HTMLElement;
    toolCallId: string;
}

/** A live transcript the main module appends to. */
export class Transcript {
    private el: HTMLElement;
    private currentAssistant: HTMLElement | null = null;
    private pendingTools = new Map<string, PendingTool>();
    private working: HTMLElement | null = null;

    constructor(el: HTMLElement) {
        this.el = el;
    }

    /** Append a user message bubble. */
    addUser(text: string): void {
        const node = document.createElement("div");
        node.className = "message user";
        node.textContent = text;
        this.el.appendChild(node);
        this.bumpWorking();
        this.scrollBottom();
    }

    /** Begin (or continue) an assistant text block. */
    appendAssistantText(delta: string): void {
        if (!this.currentAssistant) {
            this.currentAssistant = document.createElement("div");
            this.currentAssistant.className = "message assistant";
            this.el.appendChild(this.currentAssistant);
        }
        this.currentAssistant.textContent += delta;
        this.bumpWorking();
        this.scrollBottom();
    }

    /** Finalize the current assistant block so the next one is fresh. */
    finalizeAssistant(): void {
        this.currentAssistant = null;
        this.bumpWorking();
    }

    /** Begin a tool-call row. Finalizes any in-progress text block first. */
    addTool(toolCallId: string, toolName: string, args: any): void {
        // A tool call ends the preceding text block; the next text_delta
        // (e.g. a later assistant message) must start a fresh bubble.
        this.currentAssistant = null;

        const row = document.createElement("div");
        row.className = "tool-row";
        row.dataset.toolCallId = toolCallId;

        const head = document.createElement("div");
        head.className = "tool-head";
        head.textContent = toolName;
        row.appendChild(head);

        const argsEl = document.createElement("div");
        argsEl.className = "tool-args";
        argsEl.textContent = JSON.stringify(args, null, 2);
        row.appendChild(argsEl);

        const resultEl = document.createElement("div");
        resultEl.className = "tool-result";
        resultEl.textContent = "…";
        row.appendChild(resultEl);

        this.el.appendChild(row);
        this.pendingTools.set(toolCallId, { row, argsEl, resultEl, toolCallId });
        this.bumpWorking();
        this.scrollBottom();
    }

    /** Complete a tool-call row with its result. */
    endTool(toolCallId: string, result: any, isError: boolean): void {
        const pending = this.pendingTools.get(toolCallId);
        if (!pending) return;
        this.pendingTools.delete(toolCallId);

        if (isError) pending.row.classList.add("error");

        // Extract text from the RPC result shape:
        // result = { content: [{ type: "text", text }, ...], details: {...} }
        const text = this.extractResultText(result);

        const pre = pending.resultEl;
        pre.textContent = ""; // clear "…"

        const code = document.createElement("pre");
        code.className = "tool-result-text";
        code.textContent = text;

        // Truncation + toggle for long results.
        const lines = text.split("\n");
        if (lines.length > TRUNCATE_LINES) {
            const full = code.textContent ?? "";
            const truncated = lines.slice(0, TRUNCATE_LINES).join("\n") + "\n…";
            code.textContent = truncated;
            const toggle = document.createElement("span");
            toggle.className = "toggle";
            toggle.textContent = `show all (${lines.length} lines)`;
            let expanded = false;
            toggle.addEventListener("click", () => {
                expanded = !expanded;
                code.textContent = expanded ? full : truncated;
                toggle.textContent = expanded
                    ? `collapse to ${TRUNCATE_LINES} lines`
                    : `show all (${lines.length} lines)`;
            });
            pre.appendChild(code);
            pre.appendChild(toggle);
        } else {
            pre.appendChild(code);
        }
        this.bumpWorking();
        this.scrollBottom();
    }

    /** Pull a readable string out of an RPC tool result. */
    private extractResultText(result: any): string {
        if (result == null) return "";
        const content = result.content;
        if (Array.isArray(content)) {
            return content
                .map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : JSON.stringify(c)))
                .join("\n");
        }
        // Fallback: details or the whole object.
        if (typeof result === "string") return result;
        return JSON.stringify(result, null, 2);
    }

    /** Show/hide the "working…" indicator. */
    setWorking(on: boolean): void {
        if (on && !this.working) {
            const w = document.createElement("div");
            w.className = "working";
            this.el.appendChild(w);
            this.working = w;
            this.scrollBottom();
        } else if (!on && this.working) {
            this.working.remove();
            this.working = null;
        }
    }

    /** Keep the working indicator pinned to the bottom of the transcript. */
    private bumpWorking(): void {
        if (this.working) {
            this.el.appendChild(this.working); // moving an existing node re-appends it
        }
    }

    /** Clear the entire transcript. */
    clear(): void {
        this.el.innerHTML = "";
        this.currentAssistant = null;
        this.pendingTools.clear();
        this.working = null;
    }

    /** Drop any in-progress text bubble and pending (unfinished) tool rows.
     *  Called when the user stops generation: only fully-processed messages
     *  and completed tool calls remain. */
    dropInProgress(): void {
        if (this.currentAssistant) {
            this.currentAssistant.remove();
            this.currentAssistant = null;
        }
        for (const [, pending] of this.pendingTools) {
            pending.row.remove();
        }
        this.pendingTools.clear();
    }

    /** Add a "stopped by user" marker after a user-initiated stop. */
    addStoppedByUser(): void {
        const node = document.createElement("div");
        node.className = "message stopped";
        node.textContent = "⏹ Stopped by user";
        this.el.appendChild(node);
        this.scrollBottom();
    }

    private scrollBottom(): void {
        this.el.scrollTop = this.el.scrollHeight;
    }
}
