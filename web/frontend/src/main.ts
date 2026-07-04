import {
    getFiles,
    uploadFiles,
    deleteFile,
    downloadUrl,
    clearChat,
    clearAllFiles,
    stopChat,
    type FileEntry,
} from "./api.js";
import { Transcript } from "./render.js";

// --- element handles ------------------------------------------------------
const fileListEl = document.getElementById("file-list") as HTMLUListElement;
const refreshBtn = document.getElementById("refresh-files") as HTMLButtonElement;
const clearFilesBtn = document.getElementById("clear-files") as HTMLButtonElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const dropzone = document.getElementById("upload-dropzone") as HTMLDivElement;

const transcriptEl = document.getElementById("transcript") as HTMLDivElement;
const inputEl = document.getElementById("composer-input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const clearBtn = document.getElementById("clear-chat") as HTMLButtonElement;

const transcript = new Transcript(transcriptEl);

let streaming = false;
// Set when the user clicks Stop; consumed at agent_end to drop in-progress
// output and mark the transcript.
let stopRequested = false;
// Set after a user-initiated stop; the next user message is annotated to tell
// the agent its previous response was interrupted.
let wasInterrupted = false;

// --- file panel -----------------------------------------------------------
function formatSize(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function renderFiles(files: FileEntry[]): void {
    fileListEl.innerHTML = "";
    for (const f of files) {
        const li = document.createElement("li");
        li.className = f.dir ? "dir" : "file";

        const name = document.createElement("span");
        name.className = "name";
        name.textContent = f.name + (f.dir ? "/" : "");
        li.appendChild(name);

        const size = document.createElement("span");
        size.className = "size";
        size.textContent = f.dir ? "" : formatSize(f.size);
        li.appendChild(size);

        const actions = document.createElement("div");
        actions.className = "actions";
        if (!f.dir) {
            const dl = document.createElement("a");
            dl.href = downloadUrl(f.name);
            dl.download = f.name;
            dl.textContent = "↓";
            actions.appendChild(dl);
        }
        const del = document.createElement("button");
        del.textContent = "✕";
        del.title = "Delete";
        del.addEventListener("click", async () => {
            del.disabled = true;
            try {
                const updated = await deleteFile(f.name);
                renderFiles(updated);
            } catch (err) {
                alert(String(err));
                del.disabled = false;
            }
        });
        actions.appendChild(del);
        li.appendChild(actions);

        fileListEl.appendChild(li);
    }
}

async function reloadFiles(): Promise<void> {
    try {
        renderFiles(await getFiles());
    } catch (err) {
        console.error("reloadFiles failed", err);
    }
}

refreshBtn.addEventListener("click", reloadFiles);

clearFilesBtn.addEventListener("click", async () => {
    if (streaming) {
        alert("Can't clear files while the agent is working.");
        return;
    }
    if (!confirm("Delete ALL files in the workspace? This cannot be undone.")) return;
    try {
        const updated = await clearAllFiles();
        renderFiles(updated);
    } catch (err) {
        alert(String(err));
    }
});

// Upload: file input + dropzone.
async function handleUpload(files: FileList | File[]): Promise<void> {
    if (files.length === 0) return;
    try {
        const updated = await uploadFiles(files);
        renderFiles(updated);
    } catch (err) {
        alert(String(err));
    }
}

fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length > 0) {
        void handleUpload(fileInput.files);
        fileInput.value = "";
    }
});

["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add("dragover");
    });
});
["dragleave", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
    });
});
dropzone.addEventListener("drop", (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (dt?.files?.length) void handleUpload(dt.files);
});

// --- streaming state + composer ------------------------------------------
function setStreaming(on: boolean): void {
    streaming = on;
    sendBtn.disabled = on;
    inputEl.disabled = on;
    stopBtn.disabled = !on; // Stop enabled only while streaming
    transcript.setWorking(on);
    if (!on) stopRequested = false; // safety reset on turn end
}

inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !streaming) {
        e.preventDefault();
        void send();
    }
});
sendBtn.addEventListener("click", () => void send());

stopBtn.addEventListener("click", async () => {
    if (!streaming || stopRequested) return;
    stopRequested = true;
    stopBtn.disabled = true;
    try {
        await stopChat();
    } catch (err) {
        // If the stop request itself failed, undo so we don't get stuck.
        stopRequested = false;
        stopBtn.disabled = false;
        alert(String(err));
    }
});

async function send(): Promise<void> {
    const userText = inputEl.value.trim();
    if (!userText || streaming) return;
    inputEl.value = "";
    transcript.addUser(userText);

    // If the previous turn was interrupted, annotate the message sent to the
    // agent so it knows. The user's bubble above shows only their text.
    let message = userText;
    if (wasInterrupted) {
        wasInterrupted = false;
        message = `${userText}\n\n[The previous response was interrupted by the user.]`;
    }

    setStreaming(true);

    try {
        const res = await fetch("/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message }),
        });
        if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            transcript.addUser(`(error: ${res.status} ${text || res.statusText})`);
            setStreaming(false);
            return;
        }
        await consumeSSE(res.body);
    } catch (err) {
        transcript.addUser(`(network error: ${String(err)})`);
    } finally {
        setStreaming(false);
        // After a turn the agent may have changed files.
        void reloadFiles();
    }
}

/** Parse SSE frames from a fetch ReadableStream and feed the transcript. */
async function consumeSSE(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const handleEvent = (data: string): void => {
        if (!data) return;
        let evt: any;
        try { evt = JSON.parse(data); } catch { return; }
        switch (evt.kind) {
            case "text_start":
                // A new text block is beginning; finalize any in-progress one
                // so multi-message turns render as separate bubbles.
                transcript.finalizeAssistant();
                break;
            case "text_delta":
                transcript.appendAssistantText(evt.delta);
                break;
            case "tool_start":
                transcript.addTool(evt.toolCallId, evt.toolName, evt.args);
                break;
            case "tool_end":
                transcript.endTool(evt.toolCallId, evt.result, evt.isError);
                // Reload files after each completed tool call (the agent may
                // have changed the workspace).
                void reloadFiles();
                break;
            case "agent_end":
                if (stopRequested) {
                    // User-initiated stop: drop any in-progress text bubble
                    // and unfinished tool calls, leaving only completed work.
                    stopRequested = false;
                    transcript.dropInProgress();
                    transcript.addStoppedByUser();
                    wasInterrupted = true;
                } else {
                    transcript.finalizeAssistant();
                }
                return;
            case "error":
                transcript.addUser(`(agent error: ${evt.error})`);
                return;
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line (\n\n).
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            // Within a frame, take `data:` lines.
            const dataLine = frame
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).replace(/^ /, ""))
                .join("\n");
            handleEvent(dataLine);
        }
    }
    // flush any trailing frame
    if (buf.trim()) {
        const dataLine = buf
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).replace(/^ /, ""))
            .join("\n");
        handleEvent(dataLine);
    }
    transcript.finalizeAssistant();
}

// --- clear chat -----------------------------------------------------------
clearBtn.addEventListener("click", async () => {
    if (streaming) {
        alert("Can't clear while the agent is working.");
        return;
    }
    try {
        await clearChat();
        transcript.clear();
    } catch (err) {
        alert(String(err));
    }
});

// --- init -----------------------------------------------------------------
void reloadFiles();
