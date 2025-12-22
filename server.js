const express = require("express");
const path = require("path");
const { nanoid } = require("nanoid");

const { Low } = require("lowdb");
const { JSONFile } = require("lowdb/node");

const app = express();

app.use(express.json());
app.use(express.static("public"));

app.get("/health", (req, res) => res.status(200).send("ok"));

const ONE_HOUR = 60 * 60 * 1000;

// Store database in a JSON file
const dbFile = path.join(__dirname, "db.json");
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, { posts: [] });

async function initDb() {
  await db.read();
  db.data ||= { posts: [] };
  await db.write();
}

function cleanupExpired() {
  const now = Date.now();
  db.data.posts = db.data.posts.filter((p) => p.expires_at > now);
}

app.post("/posts", async (req, res) => {
  const content = (req.body.content || "").trim();
  if (!content || content.length > 500) {
    return res.status(400).json({ error: "Invalid content" });
  }

  await db.read();
  db.data ||= { posts: [] };

  const now = Date.now();
  const post = {
    id: nanoid(8),
    content,
    delete_token: nanoid(16),
    created_at: now,
    expires_at: now + ONE_HOUR
  };

  cleanupExpired();
  db.data.posts.unshift(post);
  await db.write();

  res.json({
    id: post.id,
    deleteToken: post.delete_token,
    expiresAt: post.expires_at
  });
});

app.get("/posts", async (req, res) => {
  await db.read();
  db.data ||= { posts: [] };

  cleanupExpired();
  await db.write();

  // Return fields needed by frontend
  const rows = db.data.posts
    .slice()
    .sort((a, b) => b.created_at - a.created_at)
    .map(({ id, content, created_at, expires_at }) => ({
      id, content, created_at, expires_at
    }));

  res.json(rows);
});

app.delete("/posts/:id", async (req, res) => {
  const { id } = req.params;
  const token = req.body.token;

  await db.read();
  db.data ||= { posts: [] };

  const idx = db.data.posts.findIndex((p) => p.id === id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const post = db.data.posts[idx];
  if (post.delete_token !== token) {
    return res.status(403).json({ error: "Invalid token" });
  }
  if (Date.now() > post.expires_at) {
    return res.status(403).json({ error: "Post expired" });
  }

  db.data.posts.splice(idx, 1);
  await db.write();
  res.json({ success: true });
});

// Cleanup every minute
setInterval(async () => {
  await db.read();
  db.data ||= { posts: [] };
  cleanupExpired();
  await db.write();
}, 60 * 1000);

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, "0.0.0.0", async () => {
  await initDb();
  console.log(`Running on port ${PORT}`);
});
