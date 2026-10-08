const mongoose = require("mongoose");
const { mongodbUri } = require("./env");

mongoose.connection.on("error", (error) => {
  console.error("MongoDB connection error:", error);
});

async function connectDatabase() {
  if (!mongodbUri || !/^mongodb(?:\+srv)?:\/\//.test(mongodbUri)) {
    throw new Error(
      "Set MONGODB_URI in .env to a valid MongoDB connection URI.",
    );
  }

  console.log("Connecting to MongoDB...");

  await mongoose.connect(mongodbUri, { family: 4 });
  console.log("MongoDB connected");
}

async function disconnectDatabase() {
  await mongoose.disconnect();
}

module.exports = { connectDatabase, disconnectDatabase };
