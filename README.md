# Genesis · v0

Self-contained 3D property reconstruction demo. Single HTML file, Three.js on CDN, no build step.

## Architecture

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the data flow diagram, the plan
schema, the `window.GENESIS` API, and the rules for extending the codebase.

## Tests

Open `tests.html` in a browser. Headless assertions on the data layer — 13
tests, no Three.js required.

## What's here

- **Live 3D viewer** — 6-room home, gable roof, walls + openings, furniture proxies
- **Orbit camera** (drag, scroll, right-drag to pan) — default
- **Walk camera** — click "Walk inside", capture mouse, use **WASD** to move, **Esc** to exit
- **Room labels** floating above each room in 3D (CSS2DRenderer)
- **Live stats** — rooms, sq ft, wall count update on load
- **Side panel** — sortable rooms list, openings (doors/windows) inventory

## File layout

```
genesis-v0/
├── index.html      # landing + demo + how + roadmap + CTA + footer
├── app.js          # Three.js scene, geometry, cameras
├── styles.css      # dark-mode SaaS
├── README.md
└── assets/
```

## Run locally

```bash
cd ~/genesis-v0
python3 -m http.server 8765
# → open http://localhost:8765/
```

The page uses Three.js 0.160 from unpkg via an importmap, so it needs to be served over HTTP (not file://).

## Roadmap

| Version | What's coming |
|---|---|
| v0 (today) | Demo: procedural 3D home + viewer |
| v1 | Real PDF / DWG ingestion → wall/door/window detection |
| v2 | Material library + textures |
| v3 | Export to GLB, IFC, PDF |

## Notes

- All numbers are real (sq ft, wall count) — the engine computes them from the floor plan, not faked.
- Procedural plan lives at top of `app.js` (ROOMS array). To add a room, push another `{ id, name, x, z, w, d, color, accent }`.

## Security notes

### Secrets policy (Nov 2026 onward)

**No secrets in code, ever.** Cloudflare Pages env vars are the only place secrets live. The pre-commit hook at `.git/hooks/pre-commit` blocks commits that look like API keys (Resend `re_…`, Anthropic `sk-ant-…`, OpenAI/Stripe `sk-…`, GitHub `ghp_…`, AWS `AKIA…`, Slack `xoxb/p-…`, Google `AIza…`, JWT-shaped, PEM keys).

If you need to override the hook for a benign exception: `git commit --no-verify` and write down why.

### Required Cloudflare Pages env vars

Set these in Cloudflare dashboard → Pages → genesis-v0 → Settings → Environment variables (production):

| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | API key for waitlist email notification (Resend send-only, restricted scope) |
| `ADMIN_KEY` | Random 32+ char password protecting `/stats` HTTP-basic auth |
| `ADMIN_TO` | Email address that receives new-signup notifications (fallback: `anndy@gartex-construction.com`) |
| `AUTORESPOND_FROM` | `From:` header for emails. Free Resend tier: `Genesis <onboarding@resend.dev>`. After domain verification: `Genesis <noreply@genesis-mind.com>` |

When these env vars are absent:
- `POST /api/waitlist` returns `200 {ok:true}` but logs `no provider` to the Pages Function logs
- `GET /api/stats` returns `503 {error: 'ADMIN_KEY env not set'}`

### Verifying `genesis-mind.com` doesn't expose keys

```
curl -s https://genesis-mind.com/app.js          | grep -E "re_|sk-|AKIA"  && echo "❌ leak"
curl -s https://genesis-mind.com/functions/...   | grep -E "re_|sk-|AKIA"  && echo "❌ leak"
curl -s https://genesis-mind.com/_next/...        | grep -E "re_|sk-|AKIA"  && echo "❌ leak"
```

(All should print nothing.)

### History-rewrite safety net

If a secret leak happens again, the recovery path is:

```bash
# 1. Revoke the secret in the upstream service
# 2. Strip the secret from the working tree (already done in this repo)
git commit -am "security: remove leaked $SERVICE keys"

# 3. Rewrite history to drop the leaking commit and replace with the cleanup
LEAK_SHA=$(git log --pretty=format:'%H' --diff-filter=AM -- functions/api/waitlist.js | head -1)
CLEAN_SHA=$(git rev-parse HEAD)
NEW_TREE=$(git rev-parse "$CLEAN_SHA^{tree}")
NEW=$(git commit-tree "$NEW_TREE" -p "$LEAK_SHA^" -m "$(git log -1 --format=%B $CLEAN_SHA)")
git update-ref refs/heads/main "$NEW"

# 4. Verify the leak is orphaned
git merge-base --is-ancestor "$LEAK_SHA" main && echo "❌ still reachable" || echo "✓ orphaned"

# 5. Force-push (after explicit confirmation)
git push --force-with-lease origin main
```

The pre-commit hook + the absence of any hardcoded keys in the current tree guarantee this stays handled going forward.


