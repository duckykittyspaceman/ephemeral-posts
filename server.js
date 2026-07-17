"use strict";

/**
 * Etherboard — ephemeral anonymous board.
 *
 * DESIGN RULE: nothing a user creates ever touches the disk.
 * Posts and images live in RAM only. A crash, a redeploy or a restart
 * wipes everything, by design. There is no database, no volume, no
 * upload directory, and nothing to recover.
 *
 * Single open forum. No rooms, no accounts.
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT) || 8080;

const ONE_SECOND = 1000;
const ONE_MINUTE = 60 * ONE_SECOND;

const MIN_TTL_MINUTES = 1;
const MAX_TTL_MINUTES = 60;

const SWEEP_INTERVAL_MS = 15 * ONE_SECOND;

const MAX_CONTENT_CHARS = 500;

const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB per image
const MAX_TOTAL_IMAGE_BYTES = 150 * 1024 * 1024; // 150MB of images, board-wide

const MAX_POSTS_TOTAL = 2000;

const PUBLIC_DIR = path.join(__dirname, "public");
const ANNOUNCEMENTS_PATH = path.join(__dirname, "announcements.json");

/* ------------------------------------------------------------------ *
 * State — all of it in RAM, all of it disposable
 * ------------------------------------------------------------------ */

/** @type {Map<string, object>} */ const posts = new Map();
/** @type {Map<string, {buf: Buffer, mime: string, bytes: number}>} */
const images = new Map();

let imageBytesTotal = 0;

// Regenerated every boot. Used to key rate limits without ever holding
// a raw IP address in memory. Dies with the process.
const BOOT_SALT = crypto.randomBytes(32);

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function makeId(bytes = 8) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function safeHttpUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Identify an image by its actual bytes, never by the filename or the
 * client-supplied Content-Type. Both of those are attacker-controlled.
 */
function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: "GIF87a" | "GIF89a"
  const gif = buf.subarray(0, 6).toString("latin1");
  if (gif === "GIF87a" || gif === "GIF89a") {
    return "image/gif";
  }
  // WEBP: "RIFF" .... "WEBP"
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}

function forgetImage(imageId) {
  const img = images.get(imageId);
  if (!img) return;
  imageBytesTotal -= img.bytes;
  images.delete(imageId);
}

function destroyPost(post) {
  if (post.imageId) forgetImage(post.imageId);
  posts.delete(post.id);
}

/**
 * Expire posts and drop unreferenced images.
 * Deleting from a Map while iterating it is well-defined in JS.
 */
function sweep() {
  const now = Date.now();

  for (const post of posts.values()) {
    if (post.expiresAt <= now) destroyPost(post);
  }

  // Belt and braces: no image should outlive its post.
  const referenced = new Set();
  for (const p of posts.values()) if (p.imageId) referenced.add(p.imageId);
  for (const imageId of images.keys()) {
    if (!referenced.has(imageId)) forgetImage(imageId);
  }
}

/* ------------------------------------------------------------------ *
 * Static content loaded once at boot (read-only, ships with the repo)
 * ------------------------------------------------------------------ */

let ANNOUNCEMENTS = { items: [] };

function loadAnnouncements() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ANNOUNCEMENTS_PATH, "utf8"));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];

    // Sanitise here, at the boundary, so bad data can never reach a browser.
    ANNOUNCEMENTS = {
      items: items
        .filter((i) => i && typeof i === "object")
        .map((i) => ({
          id: String(i.id ?? "").slice(0, 64),
          title: String(i.title ?? "").slice(0, 120),
          body: String(i.body ?? "").slice(0, 600),
          link: safeHttpUrl(i.link), // null unless it's a real http(s) URL
          date: String(i.date ?? "").slice(0, 40),
          pinned: Boolean(i.pinned)
        }))
    };
  } catch (e) {
    console.error("Could not load announcements.json:", e.message);
    ANNOUNCEMENTS = { items: [] };
  }
}

let INDEX_TEMPLATE = "";

/**
 * The page's <script> and <style> are inline. Rather than weaken CSP with
 * 'unsafe-inline', we stamp a fresh nonce into them on every request.
 */
function loadIndexTemplate() {
  const raw = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  INDEX_TEMPLATE = raw
    .replace(/<script(?![^>]*\bsrc=)([^>]*)>/gi, '<script nonce="__CSP_NONCE__"$1>')
    .replace(/<style([^>]*)>/gi, '<style nonce="__CSP_NONCE__"$1>');
}

function sendIndex(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(INDEX_TEMPLATE.split("__CSP_NONCE__").join(res.locals.cspNonce));
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

const app = express();

app.disable("x-powered-by");

// Railway terminates TLS at its edge and forwards one hop. Without this,
// req.ip is the proxy for everyone and rate limiting would throttle the
// whole site as a single client.
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "script-src": [(req, res) => `'nonce-${res.locals.cspNonce}'`],
        "style-src": [(req, res) => `'nonce-${res.locals.cspNonce}'`],
        // The markup uses a few style="" attributes; nonces don't cover
        // those. Style attributes can't execute script, so this is safe.
        "style-src-attr": ["'unsafe-inline'"],
        "img-src": ["'self'", "blob:"], // blob: is the local upload preview
        "connect-src": ["'self'"],
        "base-uri": ["'none'"],
        "form-action": ["'none'"],
        "frame-ancestors": ["'none'"],
        "object-src": ["'none'"],
        "upgrade-insecure-requests": []
      }
    },
    crossOriginResourcePolicy: { policy: "same-origin" },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
    hsts: { maxAge: 15552000, includeSubDomains: true }
  })
);

// Only ever used for the delete token.
app.use(express.json({ limit: "8kb" }));

/* ------------------------------------------------------------------ *
 * Rate limiting
 *
 * Keyed on an HMAC of the IP using a salt that is regenerated at boot,
 * so no raw IP address is ever held in memory and the mapping is
 * unrecoverable once the process dies.
 * ------------------------------------------------------------------ */

function anonKey(req) {
  return crypto.createHmac("sha256", BOOT_SALT).update(req.ip || "unknown").digest("base64url");
}

function limiter(windowMs, limit, message) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: anonKey,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message })
  });
}

const postLimiter = limiter(5 * ONE_MINUTE, 12, "Slow down — too many posts. Try again in a few minutes.");
const readLimiter = limiter(ONE_MINUTE, 240, "Too many requests.");

/* ------------------------------------------------------------------ *
 * Uploads — memory only
 * ------------------------------------------------------------------ */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1,
    fields: 5,
    fieldSize: 8 * 1024,
    parts: 10
  }
  // No fileFilter: mimetype is a client-supplied header and proves nothing.
  // The real check is sniffImageMime() against the actual bytes, below.
});

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

app.get("/health", (req, res) => res.status(200).type("text/plain").send("ok"));

app.get("/", sendIndex);

// Rooms are gone. Old /r/<id> links people may still have lying around
// land on the main feed instead of a dead end. 302, not 301, so nothing
// gets permanently cached if rooms ever come back.
app.get("/r/:roomId", (req, res) => res.redirect(302, "/"));

// The raw file has no nonce, so serving it directly would break under CSP.
app.get("/index.html", (req, res) => res.redirect(301, "/"));

// Everything else in public/ (favicon, etc). index:false keeps the raw
// index.html from being served without its nonce.
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    dotfiles: "ignore",
    setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff")
  })
);

/**
 * Images.
 *
 * We set the Content-Type ourselves from the sniffed bytes, add nosniff,
 * and sandbox the response. Even a valid-image-with-HTML-appended polyglot
 * is inert here: the browser is told it's an image, told not to guess, and
 * told it may not execute anything.
 */
app.get("/i/:imageId", readLimiter, (req, res) => {
  const img = images.get(req.params.imageId);
  if (!img) return res.status(404).type("text/plain").send("Not found");

  res.setHeader("Content-Type", img.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "no-store");
  res.end(img.buf);
});

app.get("/announcements", readLimiter, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(ANNOUNCEMENTS);
});

/**
 * Read the feed. Pure read — nothing is written, nothing is swept.
 * Expired posts are filtered on the way out so a post is never shown
 * past its timer even between sweeps.
 */
app.get("/posts", readLimiter, (req, res) => {
  const now = Date.now();
  const out = [];

  for (const p of posts.values()) {
    if (p.expiresAt <= now) continue;
    out.push({
      id: p.id,
      content: p.content,
      image_url: p.imageUrl,
      created_at: p.createdAt,
      expires_at: p.expiresAt
    });
  }

  out.sort((a, b) => b.created_at - a.created_at);

  res.setHeader("Cache-Control", "no-store");
  res.json(out);
});

/**
 * Create a post.
 * multipart/form-data: content?, ttlMinutes?, image?
 *
 * Note there is no `await` between reading state and mutating it, so Node's
 * single thread makes this handler atomic.
 */
app.post("/posts", postLimiter, upload.single("image"), (req, res) => {
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
  const ttlRaw = typeof req.body?.ttlMinutes === "string" ? req.body.ttlMinutes.trim() : "";
  const ttlMinutes = ttlRaw ? Number(ttlRaw) : MAX_TTL_MINUTES;
  const file = req.file || null;

  if (!content && !file) {
    return res.status(400).json({ error: "Post must include text and/or an image." });
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return res.status(400).json({ error: `Text is too long (max ${MAX_CONTENT_CHARS} characters).` });
  }
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < MIN_TTL_MINUTES || ttlMinutes > MAX_TTL_MINUTES) {
    return res.status(400).json({ error: `Timer must be between ${MIN_TTL_MINUTES} and ${MAX_TTL_MINUTES} minutes.` });
  }

  if (posts.size >= MAX_POSTS_TOTAL) {
    return res.status(503).json({ error: "The board is at capacity. Try again shortly." });
  }

  let imageId = null;
  if (file) {
    const mime = sniffImageMime(file.buffer);
    if (!mime) {
      return res.status(400).json({ error: "That file isn't a supported image (PNG, JPEG, GIF or WebP)." });
    }
    if (imageBytesTotal + file.buffer.length > MAX_TOTAL_IMAGE_BYTES) {
      return res.status(503).json({ error: "Image storage is full right now. Try again shortly." });
    }
    imageId = makeId(12);
    images.set(imageId, { buf: file.buffer, mime, bytes: file.buffer.length });
    imageBytesTotal += file.buffer.length;
  }

  const now = Date.now();
  const post = {
    id: makeId(8),
    content,
    imageId,
    imageUrl: imageId ? `/i/${imageId}` : null,
    deleteToken: makeId(24),
    createdAt: now,
    expiresAt: now + ttlMinutes * ONE_MINUTE
  };

  posts.set(post.id, post);

  res.json({ id: post.id, deleteToken: post.deleteToken, expiresAt: post.expiresAt });
});

/**
 * Delete your own post, using the token handed back at creation time.
 */
app.delete("/posts/:id", postLimiter, (req, res) => {
  const post = posts.get(req.params.id);
  const token = typeof req.body?.token === "string" ? req.body.token : "";

  if (!post) return res.status(404).json({ error: "Not found." });
  if (!timingSafeEqualStr(post.deleteToken, token)) {
    return res.status(403).json({ error: "Invalid token." });
  }

  destroyPost(post);
  res.json({ success: true });
});

/* ------------------------------------------------------------------ *
 * Fallbacks
 * ------------------------------------------------------------------ */

app.use((req, res) => res.status(404).json({ error: "Not found." }));

// Anything that reaches here gets a generic message. Internal error text
// stays in the logs, not in the response body.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "Image is too large (max 3MB)." });
    }
    return res.status(400).json({ error: "Upload rejected." });
  }
  console.error("Unhandled error:", err?.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong." });
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

loadAnnouncements();
loadIndexTemplate();

setInterval(sweep, SWEEP_INTERVAL_MS).unref();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Etherboard listening on ${PORT}`);
  console.log(`Announcements loaded: ${ANNOUNCEMENTS.items.length}`);
});
