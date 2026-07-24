import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  ensureWorkspaceDir,
  getContainerForUser,
  writeWorkspaceFileBuffer,
} from "@/lib/docker";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/workspace/<instanceId>/video/upload
 *
 * Uploads a one-off reference to the video instance's uploads/ folder.
 * Unlike brand assets (global, permanent), these are per-instance and live
 * alongside the clips. They're available as references for image/video
 * generation without polluting the brand kit.
 *
 * Accepts both images (png/jpg/gif/webp) and videos (mp4/webm/mov). A video is
 * NOT usable as a reference directly — the xAI video model only accepts
 * reference IMAGES — so on upload its final frame is extracted (container
 * ffmpeg, same as the continuity last-frame extraction in ffmpeg_ops.py) and
 * stored as <uuid>.png. The returned reference path is always an image path;
 * the source video is removed after a successful extraction. If extraction
 * fails the source is kept and an error is returned (nothing is lost).
 *
 * Multipart form fields:
 *   - file: the image or video binary (required)
 *
 * Stores at <instance_folder>/uploads/<uuid>.<ext>. Returns the relative path
 * ("uploads/<uuid>.<ext>") which the ReferenceGrid selects and the generate
 * route passes to the script.
 *
 * GET /api/workspace/<instanceId>/video/upload
 * Lists one-off reference images in the instance's uploads/ folder.
 */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

const VIDEO_EXTS = new Set(["mp4", "webm", "mov"]);

export async function POST(
  req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { instanceId } = await ctx.params;

  const instance = db()
    .prepare(
      "SELECT id, user_id, workflow_type, folder FROM workflow_instances WHERE id = ? AND user_id = ?",
    )
    .get(instanceId, user.id) as
    | { id: string; user_id: number; workflow_type: string; folder: string }
    | undefined;
  if (!instance) {
    return NextResponse.json({ error: "workflow instance not found" }, { status: 404 });
  }
  if (instance.workflow_type !== "video") {
    return NextResponse.json({ error: "instance is not a video workflow" }, { status: 400 });
  }

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return NextResponse.json({ error: "container not ready" }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "missing or empty file" }, { status: 400 });
  }

  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (!ext || !(ext in MIME_BY_EXT)) {
    return NextResponse.json(
      { error: "unsupported file type (use png, jpg, gif, webp, mp4, webm, or mov)" },
      { status: 400 },
    );
  }

  const isVideo = VIDEO_EXTS.has(ext);
  const id = randomUUID();
  const uploadsDir = `${instance.folder}/uploads`;
  const filename = `${id}.${ext}`;
  const absPath = `${uploadsDir}/${filename}`;
  const relPath = `uploads/${filename}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  await ensureWorkspaceDir(row, uploadsDir);
  await writeWorkspaceFileBuffer(row, absPath, bytes);

  // For video uploads, the xAI video model can't use a video as a reference —
  // only images. Extract the final frame as a PNG (mirrors ffmpeg_ops'
  // extract_last_frame: -sseof -0.1 -vframes 1) and use THAT as the reference.
  // On success the source video is removed; on failure the source is kept and
  // we return an error so the user can retry with a different clip.
  if (isVideo) {
    const frameRel = `uploads/${id}.png`;
    const frameAbs = `${uploadsDir}/${id}.png`;
    const ffmpegCmd = `ffmpeg -y -sseof -0.1 -i '${absPath}' -vframes 1 -update 1 -q:v 2 '${frameAbs}'`;
    const { execInContainer } = await import("@/lib/docker");
    const fr = await execInContainer(
      row,
      ["bash", "-lc", ffmpegCmd],
      { user: "appuser" },
    );
    if (fr.code !== 0) {
      // Source video is left on disk; nothing is lost.
      return NextResponse.json(
        { error: `could not extract a frame from the video (${fr.stderr.trim().slice(0, 200) || "ffmpeg failed"})` },
        { status: 422 },
      );
    }
    // Frame extracted — remove the source video to keep uploads/ image-only.
    await execInContainer(
      row,
      ["bash", "-lc", `rm -f '${absPath}'`],
      { user: "appuser" },
    );
    return NextResponse.json({
      path: frameRel,
      filename: file.name,
      size: bytes.length,
      isVideoFrame: true,
    }, { status: 201 });
  }

  return NextResponse.json({
    path: relPath,
    filename: file.name,
    size: bytes.length,
  }, { status: 201 });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { instanceId } = await ctx.params;

  const instance = db()
    .prepare(
      "SELECT id, user_id, workflow_type, folder FROM workflow_instances WHERE id = ? AND user_id = ?",
    )
    .get(instanceId, user.id) as
    | { id: string; user_id: number; workflow_type: string; folder: string }
    | undefined;
  if (!instance) {
    return NextResponse.json({ error: "workflow instance not found" }, { status: 404 });
  }

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return NextResponse.json({ error: "container not ready" }, { status: 503 });
  }

  // List files in the uploads dir via execInContainer.
  const { execInContainer } = await import("@/lib/docker");
  const uploadsDir = `${instance.folder}/uploads`;
  const res = await execInContainer(
    row,
    ["bash", "-lc", `ls -1 '${uploadsDir}' 2>/dev/null || true`],
    { user: "appuser" },
  );
  const files = res.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
    .map((filename) => ({
      path: `uploads/${filename}`,
      filename,
    }));

  return NextResponse.json({ uploads: files });
}
