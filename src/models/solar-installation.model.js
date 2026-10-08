const mongoose = require("mongoose");
const { createSchema, parentField, nameField, hashField } = require("./shared");

const schema = createSchema({
  substationId: parentField("GridSubstation", { immutable: true }),
  meterId: { ...nameField(), immutable: true },
  status: { type: String, required: true, enum: ["active", "inactive"], default: "active" },
  deviceCredentialHash: hashField(),
  // Temporary transaction write lock; never part of the public representation.
  _ingestionLock: { type: String, select: false },
});
schema.index({ meterId: 1 }, { unique: true });
schema.index({ substationId: 1, publicId: 1 });
module.exports = mongoose.model("SolarInstallation", schema, "solar_installations");
