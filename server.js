const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const { nanoid } = require("nanoid");

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.get("/health", (req, res) => res.status(200).send("ok"));

const ONE_HOUR = 60 * 60 * 1000;
const DB_PATH = path.join(__dirname, "db.json");

async function readDb() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.posts)) return { posts: [] };
    return data;
  } catch {
    return { posts: [] };
  }
}

async function writeDb(data) {
  await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2));
}

function cleanupExpired(data) {
  const now = Date.now();
  data.posts = data.posts.filter(p => p.expires_at > now);
}

app.post("/posts", async (req, res) => {
  const content = (req.body.content || "").trim();
  if (!content || content.length > 500) {
    return res.status(400).json({ error: "Invalid content" });
  }

  const data = await readDb();
  cleanupExpired(data);

  const now = Date.now();
  const post = {
    id: nanoid(8),
    content,
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
    data.posts.map(({ id, content, created_at, expires_at }) => ({
      id, content, created_at, expires_at
    }))
  );
});

app.delete("/posts/:id", async (req, res) => {
  const { id } = req.params;
  const { token } = req.body;

  const data = await readDb();
  cleanupExpired(data);

  const index = data.posts.findIndex(p => p.id === id);
  if (index === -1) return res.status(404).json({ error: "Not found" });

  if (data.posts[index].delete_token !== token) {
    return res.status(403).json({ error: "Invalid token" });
  }

  data.posts.splice(index, 1);
  await writeDb(data);
  res.json({ success: true });
});

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
