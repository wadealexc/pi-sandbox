// Fetch wrappers for the backend REST endpoints.
// SSE chat is handled in main.ts (fetch + ReadableStream reader), not here.

export interface FileEntry {
    name: string;
    size: number;
    dir: boolean;
}

const BASE = ""; // same origin; vite dev proxy handles routing in dev

async function jsonOrThrow(res: Response): Promise<any> {
    const text = await res.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) {
        const msg = body?.error ?? body ?? `${res.status} ${res.statusText}`;
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return body;
}

/** GET /files — flat top-level listing. */
export async function getFiles(): Promise<FileEntry[]> {
    const res = await fetch(`${BASE}/files`);
    const body = await jsonOrThrow(res);
    return body.files as FileEntry[];
}

/** POST /files — multipart upload, field name "files". Returns updated list. */
export async function uploadFiles(files: FileList | File[]): Promise<FileEntry[]> {
    const form = new FormData();
    for (const f of Array.from(files)) form.append("files", f);
    const res = await fetch(`${BASE}/files`, { method: "POST", body: form });
    const body = await jsonOrThrow(res);
    return body.files as FileEntry[];
}

/** DELETE /files/:name — remove a single file or empty dir. Returns updated list. */
export async function deleteFile(name: string): Promise<FileEntry[]> {
    const res = await fetch(`${BASE}/files/${encodeURIComponent(name)}`, { method: "DELETE" });
    const body = await jsonOrThrow(res);
    return body.files as FileEntry[];
}

/** GET /files/:name — download a file. Returns a blob object URL. */
export function downloadUrl(name: string): string {
    return `${BASE}/files/${encodeURIComponent(name)}`;
}

/** POST /chat/clear — start a fresh session. */
export async function clearChat(): Promise<void> {
    const res = await fetch(`${BASE}/chat/clear`, { method: "POST" });
    await jsonOrThrow(res);
}
