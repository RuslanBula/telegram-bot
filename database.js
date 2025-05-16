const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./reviews.db');

db.serialize(() => {
    db.run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identifier TEXT,
      review TEXT,
      user_id INTEGER,
      timestamp INTEGER
    )
  `);
});

module.exports = db;