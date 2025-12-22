const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const { nanoid } = require("nanoid");

const app = express();
const db = new sqlite3.Database("./posts.db");

app.use(express.json());
app.use(express.static("public"));

const ONE_HOUR = 60 * 60 * 1000;

/* Database */
db.run(`
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    delete_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )
`);

/* Create Post */
app.post("/posts", (req, res) => {
  const content = req.body.content;

  if (!content || content.length > 500) {
    return res.status(400).json({ error: "Invalid content" });
  }

  const now = Date.now();
  const post = {
    id: nanoid(8),
    delete_token: nanoid(16),
    content,
    created_at: now,
    expires_at: now + ONE_HOUR
  };

  db.run(
    `INSERT INTO posts VALUES (?, ?, ?, ?, ?)`,
    [
      post.id,
      post.content,
      post.delete_token,
      post.created_at,
      post.expires_at
    ],
    () => {
      res.json({
        id: post.id,
        deleteToken: post.delete_token,
        expiresAt: post.expires_at
      });
    }
  );
});

/* Get Active Posts */
app.get("/posts", (req, res) => {
  db.all(
    `SELECT id, content, created_at, expires_at
     FROM posts
     WHERE expires_at > ?
     ORDER BY created_at DESC`,
    [Date.now()],
    (err, rows) => res.json(rows)
  );
});

/* Delete Post (Any Time Before Expiration) */
app.delete("/posts/:id", (req, res) => {
  const { id } = req.params;
  const { token } = req.body;

  db.get(
    `SELECT delete_token, expires_at FROM posts WHERE id = ?`,
    [id],
    (err, row) => {
      if (!row) return res.status(404).json({ error: "Not found" });

      if (row.delete_token !== token) {
        return res.status(403).json({ error: "Invalid token" });
      }

      if (Date.now() > row.expires_at) {
        return res.status(403).json({ error: "Post expired" });
      }

      db.run(`DELETE FROM posts WHERE id = ?`, [id], () => {
        res.json({ success: true });
      });
    }
  );
});

/* Cleanup Expired Posts */
setInterval(() => {
  db.run(`DELETE FROM posts WHERE expires_at <= ?`, [Date.now()]);
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
