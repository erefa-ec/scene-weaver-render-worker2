// Ember render worker — Node + ffmpeg.
// Receives { videoId, callbackUrl } from the main app, stitches the MP4,
// uploads it back to Lovable Cloud storage, and POSTs an HMAC-signed callback.

import Fastify from "fastify";
import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.env.PORT || 8080;
const SECRET = process.env.RENDER_WORKER_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SECRET || !SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing env: RENDER_WORKER_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const app = Fastify({ logger: true });

app.post("/render", async (req, reply) => {
  if (req.headers["x-render-secret"] !== SECRET) return reply.code(401).send("Unauthorized");
  const { videoId, callbackUrl } = req.body || {};
  if (!videoId || !callbackUrl) return reply.code(400).send("Missing fields");
  reply.send({ accepted: true });
  // Run async
  render(videoId, callbackUrl).catch((e) => app.log.error(e));
});

app.get("/", async () => ({ ok: true }));
app.listen({ port: Number(PORT), host: "0.0.0.0" });

async function render(videoId, callbackUrl) {
  const work = await mkdtemp(join(tmpdir(), "ember-"));
  try {
    const { data: video } = await sb.from("videos").select("*").eq("id", videoId).single();
    if (!video) throw new Error("video not found");
    const { data: scenes } = await sb.from("scenes").select("*").eq("video_id", videoId).order("idx");
    if (!scenes?.length) throw new Error("no scenes");

    // Download clips + VO
    const inputs = [];
    for (const sc of scenes) {
      const clipPath = join(work, `clip-${sc.idx}.mp4`);
      const url = sc.clip_url || sc.keyframe_url;
      if (!url) continue;
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      // If it's an image (no clip), create a 5s still video from it
      if (!sc.clip_url) {
        const imgPath = join(work, `img-${sc.idx}.png`);
        await writeFile(imgPath, Buffer.from(buf));
        await ff(["-y", "-loop", "1", "-i", imgPath, "-t", "5", "-r", "30", "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080", "-pix_fmt", "yuv420p", clipPath]);
      } else {
        await writeFile(clipPath, Buffer.from(buf));
      }
      const voPath = sc.vo_url ? join(work, `vo-${sc.idx}.mp3`) : null;
      if (voPath) {
        const vobuf = await fetch(sc.vo_url).then((r) => r.arrayBuffer());
        await writeFile(voPath, Buffer.from(vobuf));
      }
      inputs.push({ clip: clipPath, vo: voPath });
    }

    // Concat clips with VO overlay per scene
    const concatList = join(work, "concat.txt");
    const merged = [];
    for (let i = 0; i < inputs.length; i++) {
      const out = join(work, `merged-${i}.mp4`);
      const args = ["-y", "-i", inputs[i].clip];
      if (inputs[i].vo) args.push("-i", inputs[i].vo, "-c:v", "copy", "-map", "0:v:0", "-map", "1:a:0", "-shortest", out);
      else args.push("-c:v", "copy", "-an", out);
      await ff(args);
      merged.push(out);
    }
    await writeFile(concatList, merged.map((m) => `file '${m}'`).join("\n"));
    const finalPath = join(work, "final.mp4");
    await ff(["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-c:a", "aac", "-b:a", "192k", finalPath]);

    // Upload
    const finalBytes = await readFile(finalPath);
    const path = `${video.user_id}/${videoId}/final.mp4`;
    const up = await sb.storage.from("media").upload(path, finalBytes, { contentType: "video/mp4", upsert: true });
    if (up.error) throw up.error;
    const signed = await sb.storage.from("media").createSignedUrl(path, 60 * 60 * 24 * 7);
    if (signed.error) throw signed.error;

    await callback(callbackUrl, { videoId, status: "done", finalUrl: signed.data.signedUrl });
  } catch (e) {
    await callback(callbackUrl, { videoId, status: "failed", error: String(e?.message ?? e) });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function ff(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: "inherit" });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg exit " + c))));
  });
}

async function callback(url, payload) {
  const body = JSON.stringify(payload);
  const sig = createHmac("sha256", SECRET).update(body).digest("hex");
  await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-render-signature": sig }, body });
}
