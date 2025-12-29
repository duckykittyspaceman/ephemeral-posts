const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const fssync = require("fs");
const multer = require("multer");
const { nanoid } = require("nanoid");

const app = express();

// JSON body needed for DELETE route; uploads use multipart (multer)
app.use(express.json({ limit: "1mb" }));

// Serve frontend
app.use(express.static("public"));

/**
 * Config
 */
const MAX_TTL_MINUTES = 60;
const MIN_TTL_MINUTES = 1;
const ONE_MINUTE = 60 * 1000;
const ONE_HOUR = 60 * ONE_MINUTE;

// Rooms are deleted when there are no heartbeats for this long.
// This approximates "room disappears after all users leave".
const ROOM_EMPTY_GRACE_MS = 60 * 1000; // 60 seconds

const DB_PATH = path.join(__dirname, "db.json");
const ANNOUNCEMENTS_PATH = path.join(__dirname, "announcements.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");

// Serve uploaded images
app.use("/uploads", express.static(UPLOADS_DIR));

app.get("/health", (req, res) => res.status(200).send("ok"));

/**
 * Serve the same SPA page for room links:
 * https://etherboard.net/r/<roomId>
 */
app.get("/r/:roomId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/**
 * Ensure uploads dir exists
 */
async function ensureUploadsDir() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

/**
 * JSON helpers
 */
async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

/**
 * DB structure:
 * {
 *   posts: [{ id, room_id|null, content, image_url, image_path, created_at, expires_at, delete_token }],
 *   rooms: [{ id, created_at, last_active_at }]
 * }
 */
async function readDb() {
  const data = await readJsonFile(DB_PATH, { posts: [], rooms: [] });
  if (!data || typeof data !== "object") return { posts: [], rooms: [] };
  if (!Array.isArray(data.posts)) data.posts = [];
  if (!Array.isArray(data.rooms)) data.rooms = [];
  return data;
}

async function writeDb(data) {
  await writeJsonFile(DB_PATH, data);
}

/**
 * File deletion helpers
 */
async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore missing / already deleted
  }
}

function filePathFromImageUrl(image_url) {
  if (!image_url) return null;
  if (!image_url.startsWith("/uploads/")) return null;
  const filename = image_url.replace("/uploads/", "");
  return path.join(UPLOADS_DIR, filename);
}

async function deletePostImage(post) {
  const p = post.image_path || filePathFromImageUrl(post.image_url);
  if (p) await safeUnlink(p);
}

/**
 * Cleanup expired posts and delete their images
 */
async function cleanupExpiredPosts(data) {
  const now = Date.now();
  const posts = data.posts || [];

  const expired = posts.filter((p) => p.expires_at <= now);
  data.posts = posts.filter((p) => p.expires_at > now);

  for (const p of expired) {
    await deletePostImage(p);
  }
}

/**
 * Orphan sweep:
 * Delete files in uploads/ older than ONE_HOUR that are not referenced by any active post.
 */
async function sweepOrphanUploads(data) {
  let files = [];
  try {
    files = await fs.readdir(UPLOADS_DIR);
  } catch {
    return;
  }

  const referenced = new Set(
    (data.posts || [])
      .map((p) => (p.image_url && p.image_url.startsWith("/uploads/") ? p.image_url.replace("/uploads/", "") : null))
      .filter(Boolean)
  );

  const now = Date.now();

  for (const filename of files) {
    if (!filename || filename.startsWith(".")) continue;

    const fullPath = path.join(UPLOADS_DIR, filename);

    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }

    const ageMs = now - stat.mtimeMs;

    if (!referenced.has(filename) && ageMs > ONE_HOUR) {
      await safeUnlink(fullPath);
    }
  }
}

/**
 * Rooms:
 * - Keep rooms in DB
 * - Each active client pings /rooms/:id/ping every ~20s
 * - If no ping for ROOM_EMPTY_GRACE_MS, delete the room and all its posts/images
 */
function getRoomById(data, roomId) {
  return (data.rooms || []).find((r) => r.id === roomId) || null;
}

async function deleteRoomAndItsPosts(data, roomId) {
  // Remove posts in room + delete images
  const inRoom = (data.posts || []).filter((p) => p.room_id === roomId);
  for (const p of inRoom) {
    await deletePostImage(p);
  }
  data.posts = (data.posts || []).filter((p) => p.room_id !== roomId);

  // Remove room
  data.rooms = (data.rooms || []).filter((r) => r.id !== roomId);
}

async function cleanupEmptyRooms(data) {
  const now = Date.now();
  const rooms = data.rooms || [];
  const toDelete = rooms.filter((r) => (r.last_active_at || r.created_at) + ROOM_EMPTY_GRACE_MS < now);

  for (const r of toDelete) {
    await deleteRoomAndItsPosts(data, r.id);
  }
}

/**
 * Maintenance
 */
async function runMaintenance() {
  const data = await readDb();
  await cleanupExpiredPosts(data);
  await cleanupEmptyRooms(data);
  await sweepOrphanUploads(data);
  await writeDb(data);
}

/**
 * Multer config (direct uploads)
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".bin";
    cb(null, `${Date.now()}-${nanoid(10)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype || "");
    if (!ok) return cb(new Error("Only images allowed (png, jpg, jpeg, webp, gif)."));
    cb(null, true);
  }
});

/**
 * Announcements
 */
app.get("/announcements", async (req, res) => {
  const data = await readJsonFile(ANNOUNCEMENTS_PATH, { items: [] });
  if (!data || !Array.isArray(data.items)) return res.json({ items: [] });
  res.json(data);
});

/**
 * Create room
 * Body: { label?: string }
 * Returns: { roomId, joinUrl }
 */
app.post("/rooms", async (req, res) => {
  const label = String(req.body?.label || "").trim().slice(0, 40);

  const data = await readDb();
  await cleanupExpiredPosts(data);
  await cleanupEmptyRooms(data);

  const roomId = nanoid(10);
  const now = Date.now();

  data.rooms.unshift({
    id: roomId,
    label: label || null,
    created_at: now,
    last_active_at: now
  });

  await writeDb(data);

  const joinUrl = `${req.protocol}://${req.get("host")}/r/${roomId}`;
  res.json({ roomId, joinUrl });
});

/**
 * Room heartbeat
 * POST /rooms/:id/ping
 */
app.post("/rooms/:id/ping", async (req, res) => {
  const roomId = req.params.id;

  const data = await readDb();
  const room = getRoomById(data, roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });

  room.last_active_at = Date.now();
  await writeDb(data);

  res.json({ ok: true });
});

/**
 * Posts (main feed or rooms)
 *
 * GET /posts?roomId=<optional>
 * - roomId omitted => main feed
 * - roomId provided => room feed
 */
app.get("/posts", async (req, res) => {
  const roomId = req.query.roomId ? String(req.query.roomId) : null;

  const data = await readDb();
  await cleanupExpiredPosts(data);
  await cleanupEmptyRooms(data);
  await writeDb(data);

  // If roomId is specified, validate room exists
  if (roomId) {
    const room = getRoomById(data, roomId);
    if (!room) return res.status(404).json({ error: "Room not found" });
  }

  const filtered = (data.posts || []).filter((p) => (roomId ? p.room_id === roomId : !p.room_id));

  res.json(
    filtered.map(({ id, content, image_url, created_at, expires_at }) => ({
      id, content, image_url, created_at, expires_at
    }))
  );
});

/**
 * Create post/message
 * multipart/form-data:
 * - content (optional, max 500)
 * - ttlMinutes (optional; 1..60; default 60)
 * - roomId (optional; if present, posts into that room)
 * - image (optional file)
 */
app.post("/posts", upload.single("image"), async (req, res) => {
  try {
    const content = (req.body.content || "").trim();
    const roomIdRaw = req.body.roomId ? String(req.body.roomId).trim() : "";
    const roomId = roomIdRaw ? roomIdRaw : null;

    const ttlRaw = req.body.ttlMinutes ? String(req.body.ttlMinutes).trim() : "";
    const ttlMinutes = ttlRaw ? Number(ttlRaw) : MAX_TTL_MINUTES;

    const file = req.file || null;

    // Basic validation
    if (!content && !file) {
      return res.status(400).json({ error: "Post must include text and/or an image." });
    }
    if (content.length > 500) {
      if (file?.path) await safeUnlink(file.path);
      return res.status(400).json({ error: "Text is too long (max 500 chars)." });
    }

    if (!Number.isFinite(ttlMinutes) || ttlMinutes < MIN_TTL_MINUTES || ttlMinutes > MAX_TTL_MINUTES) {
      if (file?.path) await safeUnlink(file.path);
      return res.status(400).json({ error: "ttlMinutes must be between 1 and 60." });
    }

    const data = await readDb();
    await cleanupExpiredPosts(data);
    await cleanupEmptyRooms(data);

    // If posting into a room, ensure it exists and mark active
    if (roomId) {
      const room = getRoomById(data, roomId);
      if (!room) {
        if (file?.path) await safeUnlink(file.path);
        return res.status(404).json({ error: "Room not found" });
      }
      room.last_active_at = Date.now();
    }

    const now = Date.now();

    let image_url = null;
    let image_path = null;
    if (file) {
      image_url = `/uploads/${file.filename}`;
      image_path = file.path;
    }

    const post = {
      id: nanoid(8),
      room_id: roomId, // null for main feed
      content,
      image_url,
      image_path,
      delete_token: nanoid(16),
      created_at: now,
      expires_at: now + ttlMinutes * ONE_MINUTE
    };

    data.posts.unshift(post);
    await writeDb(data);

    return res.json({
      id: post.id,
      deleteToken: post.delete_token,
      expiresAt: post.expires_at
    });
  } catch (e) {
    const msg = e?.message || "Upload failed.";
    return res.status(400).json({ error: msg });
  }
});

/**
 * Delete post (optional feature)
 */
app.delete("/posts/:id", async (req, res) => {
  const { id } = req.params;
  const { token } = req.body || {};

  const data = await readDb();
  await cleanupExpiredPosts(data);
  await cleanupEmptyRooms(data);

  const index = (data.posts || []).findIndex((p) => p.id === id);
  if (index === -1) return res.status(404).json({ error: "Not found" });

  const post = data.posts[index];
  if (post.delete_token !== token) return res.status(403).json({ error: "Invalid token" });

  await deletePostImage(post);

  data.posts.splice(index, 1);
  await writeDb(data);

  return res.json({ success: true });
});

/**
 * Maintenance schedule:
 * - run once at startup
 * - run every minute
 */
(async () => {
  await ensureUploadsDir();

  if (!fssync.existsSync(UPLOADS_DIR)) {
    console.warn("Uploads directory missing:", UPLOADS_DIR);
  }

  try {
    await runMaintenance();
  } catch (e) {
    console.error("Startup maintenance error:", e);
  }

  setInterval(async () => {
    try {
      await runMaintenance();
    } catch (e) {
      console.error("Maintenance error:", e);
    }
  }, 60 * 1000);

  const PORT = Number(process.env.PORT) || 8080;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Running on port ${PORT}`);
  });
})();
