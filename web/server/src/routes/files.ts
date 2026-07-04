import { Router } from "express";
import multer from "multer";
import * as path from "node:path";
import { listFiles, resolveWorkspace, removeFile, writeFile, clearAll } from "../workspace.js";

const router = Router();

// In-memory multipart storage — we write files ourselves via writeFile so we
// can apply the path-escape guard. Keep buffers in memory; MVP uploads are
// small.
const upload = multer({ storage: multer.memoryStorage() });

/** GET /files — flat top-level listing. */
router.get("/files", async (_req, res) => {
    try {
        const files = await listFiles();
        res.json({ files });
    } catch (err) {
        res.status(500).json({ error: String(err) });
    }
});

/** POST /files — multipart upload, field name "files" (one or many). */
router.post("/files", upload.array("files"), async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
        res.status(400).json({ error: "No files uploaded (use field name 'files')." });
        return;
    }
    try {
        // Attempt every file even if some have escaping names. allSettled
        // never rejects, so we inspect the results to report which writes
        // failed while still serving the updated file list.
        const results = await Promise.allSettled(
            files.map((f) => writeFile(f.originalname, f.buffer))
        );
        const errors = results
            .map((r, i) =>
                r.status === "rejected"
                    ? `${files[i].originalname}: ${String(r.reason)}`
                    : null
            )
            .filter((s): s is string => s !== null);
        const updated = await listFiles();
        if (errors.length) {
            res.status(400).json({ error: errors.join("; "), files: updated });
        } else {
            res.json({ files: updated });
        }
    } catch (err) {
        res.status(500).json({ error: String(err) });
    }
});

/** DELETE /files — clear every top-level entry in the workspace. */
router.delete("/files", async (_req, res) => {
    try {
        await clearAll();
        const updated = await listFiles();
        res.json({ files: updated });
    } catch (err) {
        res.status(500).json({ error: String(err) });
    }
});

/** DELETE /files/:name — remove a single file or directory (recursive). */
router.delete("/files/:name", async (req, res) => {
    try {
        await removeFile(req.params.name);
        const updated = await listFiles();
        res.json({ files: updated });
    } catch (err) {
        // Missing file vs. real error: fs.rm with force:false throws ENOENT.
        res.status(404).json({ error: String(err) });
    }
});

/** GET /files/:name — download a file. */
router.get("/files/:name", async (req, res) => {
    try {
        const full = resolveWorkspace(req.params.name);
        res.download(full, path.basename(full));
    } catch (err) {
        res.status(400).json({ error: String(err) });
    }
});

export default router;
