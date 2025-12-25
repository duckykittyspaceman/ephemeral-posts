const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const fssync = require("fs");
const multer = require("multer");
const { nanoid } = require("nanoid");

const app = express();

// For JSON bodies (DELETE /posts uses JSON; announcements is GET)
app.use(express.json({ limit: "1mb" }));

// Serve frontend + uploaded images
app.use(express.static("public"));

const UPLOADS_DIR = path.join(__dirname, "uploads");
app.use("/uploads", express.static(UPLOADS_DIR));

app.get("/health", (req, res) => res.status(200).send("ok"));

const ONE_HOUR = 60 * 60 * 1000;
const DB_PATH = path.join(__dirname, "db.json");
const ANNOUNCEMENTS_PATH = path.join(__dirname, "announcements.json");

// Ensure uploads dir exists
async function ensureUploadsDir() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

// ---------- DB helpers ----------
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

async function readDb() {
  const data = await readJsonFile(DB_PATH, { posts: [] });
  if (!data || !Array.isArray(data.posts)) return { posts: [] };
  return data;
}

async function writeDb(data) {
  await writeJsonFile(DB_PATH, data);
}

// ---------- Cleanup ----------
async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore if already deleted / missing
  }
}

async function cleanupExpired(data) {
  const now = Date.now();
  const expired = [];

  for (const p of data.posts || []) {
    if (p.expires_at <= now) expired.push(p);
  }

  // remove expired from db list
  data.posts = (data.posts || []).filter((p) => p.expires_at > now);

  // delete expired images
  for (const p of expired) {
    if (p.image_path) {
      await safeUnlink(p.image_path);
    } else if (p.image_url && p.image_url.startsWith("/uploads/")) {
      // fallback for older entries that may not have image_path stored
      const file = p.image_url.replace("/uploads/", "");
      const filePath = path.join(UPLOADS_DIR, file);
      await safeUnlink(filePath);
    }
  }
}

// ---------- Multer upload config ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    // keep extension if available; default to .bin
    const ext = path.extname(file.originalname || "").toLowerCase() || ".bin";
    cb(null, `${Date.now()}-${nanoid(10)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 3 * 1024 * 1024 // 3MB (match index.html default)
  },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype || "");
    if (!ok) return cb(new Error("Only image uploads are allowed (png, jpg, jpeg, webp, gif)."));
    cb(null, true);
  }
});

// ---------- Announcements ----------
app.get("/announcements", async (req, res) => {
  const data = await readJsonFile(ANNOUNCEMENTS_PATH, { items: [] });
  if (!data || !Array.isArray(data.items)) return res.json({ items: [] });
  res.json(data);
});

// ---------- Routes ----------

// IMPORTANT: this route uses multer to parse multipart/form-data
app.post("/posts", upload.single("image"), async (req, res) => {
  try {
    const content = (req.body.content || "").trim();

    // multer provides req.file if an image was uploaded
    const file = req.file || null;

    // Require text and/or image
    if (!content && !file) {
      return res.status(400).json({ error: "Post must include text and/or an image." });
    }

    if (content.length > 500) {
      // If we already saved an upload, delete it so we don't leak files
      if (file?.path) await safeUnlink(file.path);
      return res.status(400).json({ error: "Text is too long (max 500 chars)." });
    }

    const data = await readDb();
    await cleanupExpired(data);

    const now = Date.now();

    // Build image URL if file exists
    let image_url = null;
    let image_path = null;

    if (file) {
      image_url = `/uploads/${file.filename}`;
      image_path = file.path; // absolute/relative path on disk; used for deletion later
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

    res.json({
      id: post.id,
      deleteToken: post.delete_token,
      expiresAt: post.expires_at
    });
  } catch (e) {
    // Multer/fileFilter errors often land here
    const msg = e?.message || "Upload failed.";
    return res.status(400).json({ error: msg });
  }
});

app.get("/posts", async (req, res) => {
  const data = await readDb();
  await cleanupExpired(data);
  await writeDb(data);

  res.json(
    data.posts.map(({ id, content, image_url, created_at, expires_at }) => ({
      id, content, image_url, created_at, expires_at
    }))
  );
});

app.delete("/posts/:id", async (req, res) => {
  const { id } = req.params;
  const { token } = req.body || {};

  const data = await readDb();
  await cleanupExpired(data);

  const index = data.posts.findIndex((p) => p.id === id);
  if (index === -1) return res.status(404).json({ error: "Not found" });

  const post = data.posts[index];
  if (post.delete_token !== token) return res.status(403).json({ error: "Invalid token" });

  // delete the image file if present
  if (post.image_path) {
    await safeUnlink(post.image_path);
  } else if (post.image_url && post.image_url.startsWith("/uploads/")) {
    const file = post.image_url.replace("/uploads/", "");
    await safeUnlink(path.join(UPLOADS_DIR, file));
  }

  data.posts.splice(index, 1);
  await writeDb(data);
  res.json({ success: true });
});

// Cleanup every minute
setInterval(async () => {
  try {
    const data = await readDb();
    await cleanupExpired(data);
    await writeDb(data);
  } catch (e) {
    console.error("Cleanup error:", e);
  }
}, 60 * 1000);

// Startup
const PORT = Number(process.env.PORT) || 8080;

(async () => {
  await ensureUploadsDir();

  // Optional: sanity cleanup if uploads dir is missing (shouldn't happen after mkdir)
  if (!fssync.existsSync(UPLOADS_DIR)) {
    console.warn("Uploads directory missing:", UPLOADS_DIR);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Running on port ${PORT}`);
  });
})();
