const mongoose = require('mongoose');

async function checkDatabase() {
  const connection = mongoose.connection;
  if (connection.readyState !== 1 || !connection.db) return false;
  try {
    const result = await connection.db.command({ ping: 1 }, { timeoutMS: 2000 });
    return result.ok === 1;
  } catch {
    return false;
  }
}

module.exports = { checkDatabase };
