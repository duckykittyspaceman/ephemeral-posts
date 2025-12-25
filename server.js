const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const { nanoid } = require("nanoid");

const app = express();
app.use(express.json({ limit: "1mb" })); // JSON only; images are uploaded client-side to Cloudinary
app.use(express.static("public"));

app.get("/health", (req, res) => res.status(200).send("ok"));

const ONE_HOUR = 60 * 60 * 1000;

// NOTE: Railway may restart and wipe local filesystem unless you attach a volume.
// Keep as-is for now; consider a volume later if needed.
const DB_PATH = path.join(__dirname, "db.json");
const ANNOUNCEMENTS_PATH = path.join(__dirname, "announcements.json");

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

function cleanupExpired(data) {
  const now = Date.now();
  data.posts = (data.posts || []).filter((p) => p.expires_at > now);
}

// --- NEW: Announcements (pinned updates) ---
app.get("/announcements", async (req, res) => {
  const data = await readJsonFile(ANNOUNCEMENTS_PATH, { items: [] });
  if (!data || !Array.isArray(data.items)) return res.json({ items: [] });
  res.json(data);
});

// --- Posts ---
app.post("/posts", async (req, res) => {
  const content = (req.body.content || "").trim();
  const imageUrl = (req.body.imageUrl || "").trim();

  // Require text and/or image
  if ((!content && !imageUrl) || content.length > 500) {
    return res.status(400).json({ error: "Post must include text and/or an image (max 500 chars)." });
  }

  // Basic URL guard (client uploads to Cloudinary, so this should be https://...)
  if (imageUrl && !/^https?:\/\/.+/i.test(imageUrl)) {
    return res.status(400).json({ error: "Invalid image URL." });
  }

  const data = await readDb();
  cleanupExpired(data);

  const now = Date.now();
  const post = {
    id: nanoid(8),
    content,
    image_url: imageUrl || null,
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
});

app.get("/posts", async (req, res) => {
  const data = await readDb();
  cleanupExpired(data);
  await writeDb(data);

  res.json(
    data.posts.map(({ id, content, image_url, created_at, expires_at }) => ({
      id, content, image_url, created_at, expires_at
    }))
  );
});

app.delete("/posts/:id", async (req, res) => {
  const { id } = req.params;
  const { token } = req.body;

  const data = await readDb();
  cleanupExpired(data);

  const index = data.posts.findIndex((p) => p.id === id);
  if (index === -1) return res.status(404).json({ error: "Not found" });

  if (data.posts[index].delete_token !== token) {
    return res.status(403).json({ error: "Invalid token" });
  }

  data.posts.splice(index, 1);
  await writeDb(data);
  res.json({ success: true });
});

// Cleanup every minute
setInterval(async () => {
  try {
    const data = await readDb();
    cleanupExpired(data);
    await writeDb(data);
  } catch (e) {
    console.error("Cleanup error:", e);
  }
}, 60 * 1000);

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Running on port ${PORT}`);
});