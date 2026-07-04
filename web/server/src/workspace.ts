import * as fs from "node:fs/promises";
import * as path from "node:path";

// The workspace directory, bind-mounted into the container. All file ops
// are direct fs calls — no round-trip through the agent.
const WORKSPACE = process.env.WORKSPACE ?? "/workspace";

export interface FileEntry {
    name: string;
    size: number;
    dir: boolean;
}

/** Flat top-level listing of the workspace (one level deep). */
export async function listFiles(): Promise<FileEntry[]> {
    const entries = await fs.readdir(WORKSPACE, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries) {
        const full = path.join(WORKSPACE, entry.name);
        let size = 0;
        if (!entry.isDirectory()) {
            try {
                const stat = await fs.stat(full);
                size = stat.size;
            } catch {
                // file vanished between readdir and stat; skip it
                continue;
            }
        }
        result.push({ name: entry.name, size, dir: entry.isDirectory() });
    }
    // Sort: directories first, then alphabetical. Stable for the UI.
    result.sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return result;
}

/** Resolve a client-supplied name to a workspace path, refusing escapes. */
export function resolveWorkspace(name: string): string {
    // Normalize and strip any leading slash so path.join can't be tricked
    // into an absolute path outside the workspace.
    const cleaned = path.normalize(name).replace(/^([/\\])+/, "");
    const full = path.join(WORKSPACE, cleaned);
    // Final guard: the resolved path must be inside WORKSPACE.
    const rel = path.relative(WORKSPACE, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Path escapes workspace: ${name}`);
    }
    return full;
}

/** Write uploaded file bytes into the workspace. */
export async function writeFile(name: string, data: Buffer): Promise<void> {
    const full = resolveWorkspace(name);
    await fs.writeFile(full, data);
}

/** Remove a file or empty directory from the workspace. */
export async function removeFile(name: string): Promise<void> {
    const full = resolveWorkspace(name);
    await fs.rm(full, { recursive: false, force: false });
}

export { WORKSPACE };
