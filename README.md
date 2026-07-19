# Ember render worker

A tiny Node + ffmpeg service that takes a finished `video` row from Ember,
downloads its scene clips + voiceover, stitches them into a final MP4, uploads
it back to Lovable Cloud storage, and POSTs an HMAC-signed callback to
`/api/public/render-complete`.

This service runs **outside** the main Lovable app — Lovable's edge runtime
can't run ffmpeg. Deploy it to Fly.io, Railway, Render, or any container host.

## Env vars

| Name | Description |
|------|-------------|
| `SUPABASE_URL` | From your Lovable Cloud project |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (Cloud → Settings) |
| `RENDER_WORKER_SECRET` | Shared HMAC secret. Must match the same env var in the main app. |
| `CALLBACK_URL` | e.g. `https://your-project.lovable.app/api/public/render-complete` |
| `PORT` | Defaults to 8080 |

## How the main app talks to it

Set these in **Project Settings → Secrets** of the Lovable app:

- `RENDER_WORKER_URL` — the public URL of this worker's `/render` endpoint
- `RENDER_WORKER_SECRET` — the shared secret above
- `RENDER_CALLBACK_URL` — `https://<your-app>.lovable.app/api/public/render-complete`

When all three are set, the pipeline POSTs to the worker after VO is done.
When they're missing, the app falls back to a "preview-only" mode and shows
keyframes + per-scene audio without a stitched MP4.

## Endpoint

`POST /render`
Header: `x-render-secret: <RENDER_WORKER_SECRET>`
Body: `{ "videoId": "<uuid>", "callbackUrl": "..." }`

The worker:
1. Loads the video + its scenes (in `idx` order).
2. Downloads each `clip_url` (or `keyframe_url` as fallback) and `vo_url` to /tmp.
3. ffmpeg: concat clips, normalize to a single resolution, mix VO on top with
   crossfades between scenes.
4. Uploads the result to `<userId>/<videoId>/final.mp4` in the `media` bucket.
5. POSTs `{ videoId, status: "done", finalUrl, thumbnailUrl }` to the
   callback URL with an `x-render-signature` HMAC-SHA256 of the body.

See `server.js` for the implementation and `Dockerfile` for the container.
