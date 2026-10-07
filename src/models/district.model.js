const mongoose = require("mongoose");
const { createSchema, parentField, nameField } = require("./shared");

const schema = createSchema({
  provinceId: parentField("Province", { immutable: true }),
  name: nameField(),
});
schema.index({ provinceId: 1, publicId: 1 });
module.exports = mongoose.model("District", schema, "districts");
