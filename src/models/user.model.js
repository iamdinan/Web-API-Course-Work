const mongoose = require("mongoose");
const { createSchema, parentField, hashField } = require("./shared");

const schema = createSchema({
  email: { type: String, required: true, trim: true, lowercase: true, match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  passwordHash: hashField(),
  role: { type: String, required: true, enum: ["user", "admin"], default: "user" },
  readScope: { type: String, required: true, enum: ["national", "province", "district"] },
  provinceId: parentField("Province", { required: false }),
  districtId: parentField("District", { required: false }),
});

schema.pre("validate", function () {
  const province = this.provinceId != null;
  const district = this.districtId != null;
  if (this.role === "admin" && this.readScope !== "national") {
    this.invalidate("readScope", "Admins require national read scope.");
  }
  const validScope = (this.readScope === "national" && !province && !district) ||
    (this.readScope === "province" && province && !district) ||
    (this.readScope === "district" && district && !province);
  if (!validScope) this.invalidate("readScope", "Jurisdiction fields must match read scope.");
});
schema.index({ email: 1 }, { unique: true });
module.exports = mongoose.model("User", schema, "users");
