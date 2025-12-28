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
 * Storage locations (NOTE: on Railway without Volumes, local disk can reset on restarts)
 */
const ONE_HOUR = 60 * 60 * 1000;
const DB_PATH = path.join(__dirname, "db.json");
const ANNOUNCEMENTS_PATH = path.join(__dirname, "announcements.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");

// Serve uploaded images
app.use("/uploads", express.static(UPLOADS_DIR));

app.get("/health", (req, res) => res.status(200).send("ok"));

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
 * DB helpers
 */
async function readDb() {
  const data = await readJsonFile(DB_PATH, { posts: [] });
  if (!data || !Array.isArray(data.posts)) return { posts: [] };
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
  // Prefer stored path; fallback to deriving from image_url
  const p = post.image_path || filePathFromImageUrl(post.image_url);
  if (p) await safeUnlink(p);
}

/**
 * Cleanup expired posts and delete their images
 */
async function cleanupExpired(data) {
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
 * This handles:
 * - restarts
 * - partial writes
 * - missing image_path
 * - db resets
 */
async function sweepOrphanUploads(data) {
  let files = [];
  try {
    files = await fs.readdir(UPLOADS_DIR);
  } catch {
    return; // uploads dir may not exist yet
  }

  const referenced = new Set(
    (data.posts || [])
      .map((p) => {
        if (p.image_url && p.image_url.startsWith("/uploads/")) {
          return p.image_url.replace("/uploads/", "");
        }
        return null;
      })
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

    // Delete if not referenced and older than ONE_HOUR
    if (!referenced.has(filename) && ageMs > ONE_HOUR) {
      await safeUnlink(fullPath);
    }
  }
}

/**
 * Run both cleanup routines and persist DB
 */
async function runMaintenance() {
  const data = await readDb();
  await cleanupExpired(data);
  await sweepOrphanUploads(data);
  await writeDb(data);
}

/**
 * Multer config for direct uploads
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
 * Announcements (pinned updates)
 */
app.get("/announcements", async (req, res) => {
  const data = await readJsonFile(ANNOUNCEMENTS_PATH, { items: [] });
  if (!data || !Array.isArray(data.items)) return res.json({ items: [] });
  res.json(data);
});

/**
 * Posts
 * Accept multipart/form-data:
 * - field "content" (optional, max 500 chars)
 * - file "image" (optional)
 */
app.post("/posts", upload.single("image"), async (req, res) => {
  try {
    const content = (req.body.content || "").trim();
    const file = req.file || null;

    if (!content && !file) {
      return res.status(400).json({ error: "Post must include text and/or an image." });
    }

    if (content.length > 500) {
      if (file?.path) await safeUnlink(file.path);
      return res.status(400).json({ error: "Text is too long (max 500 chars)." });
    }

    // Maintenance pass before write (keeps DB tidy)
    const data = await readDb();
    await cleanupExpired(data);

    const now = Date.now();

    let image_url = null;
    let image_path = null;
    if (file) {
      image_url = `/uploads/${file.filename}`;
      image_path = file.path;
    }

    const post = {
      id: nanoid(8),
      content,
      image_url,
      image_path,
      delete_token: nanoid(16),
      created_at: now,
      expires_at: now + ONE_HOUR
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

app.get("/posts", async (req, res) => {
  const data = await readDb();
  await cleanupExpired(data);
  await writeDb(data);

  res.json(
    (data.posts || []).map(({ id, content, image_url, created_at, expires_at }) => ({
      id, content, image_url, created_at, expires_at
    }))
  );
});

app.delete("/posts/:id", async (req, res) => {
  const { id } = req.params;
  const { token } = req.body || {};

  const data = await readDb();
  await cleanupExpired(data);

  const index = (data.posts || []).findIndex((p) => p.id === id);
  if (index === -1) return res.status(404).json({ error: "Not found" });

  const post = data.posts[index];
  if (post.delete_token !== token) return res.status(403).json({ error: "Invalid token" });

  // Delete image file
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

  // Helpful warning if uploads dir somehow doesn't exist
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
