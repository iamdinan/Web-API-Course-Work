const mongoose = require("mongoose");
const { mongodbUri } = require("./env");

mongoose.connection.on("error", () => {
  // Driver error messages can contain connection details. Never log the URI.
  console.error("MongoDB connection error. Check database access and connectivity.");
});

async function connectDatabase() {
  if (!mongodbUri || !/^mongodb(?:\+srv)?:\/\//.test(mongodbUri)) {
    throw new Error("Set MONGODB_URI in .env to a valid MongoDB connection URI.");
  }

  console.log("Connecting to MongoDB...");

  try {
    await mongoose.connect(mongodbUri);
    console.log("MongoDB connected");
  } catch {
    throw new Error(
      "MongoDB connection failed. Check MONGODB_URI, database credentials, and Atlas network access.",
    );
  }
}

async function disconnectDatabase() {
  await mongoose.disconnect();
}

module.exports = { connectDatabase, disconnectDatabase };
