const mongoose = require("mongoose");
const { createSchema, parentField } = require("./shared");

const measurement = () => ({
  type: Number, required: true, min: 0, immutable: true,
  validate: { validator: Number.isFinite, message: "Measurement must be finite." },
});

const schema = createSchema({
  installationId: parentField("SolarInstallation", { immutable: true }),
  recordedAt: { type: Date, required: true, immutable: true },
  powerKw: measurement(),
  energyKwh: measurement(),
  voltageV: measurement(),
  receivedAt: { type: Date, required: true, default: Date.now, immutable: true },
});
schema.index({ installationId: 1, recordedAt: 1 }, { unique: true });
schema.index({ installationId: 1, recordedAt: -1, publicId: -1 });
schema.index({ recordedAt: -1, publicId: -1 });

function appendOnly() {
  throw new Error("Generation readings are append-only.");
}

schema.pre("save", function () {
  if (!this.isNew && this.isModified()) appendOnly();
});
// Only insert-if-missing upserts are permitted; existing readings cannot change.
schema.pre("updateOne", function () {
  const update = this.getUpdate();
  const filter = this.getFilter();
  if (!this.getOptions().upsert || !update || Object.keys(update).some(key => key !== "$setOnInsert") ||
      !update.$setOnInsert || typeof filter.installationId !== "string" || !(filter.recordedAt instanceof Date)) {
    appendOnly();
  }
});
schema.pre(["updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace",
  "deleteMany", "findOneAndDelete"], appendOnly);
schema.pre("deleteOne", { document: true, query: true }, appendOnly);
schema.pre("bulkWrite", appendOnly);

module.exports = mongoose.model("GenerationReading", schema, "generation_readings");
