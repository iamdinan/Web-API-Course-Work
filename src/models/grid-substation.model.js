const mongoose = require("mongoose");
const { createSchema, parentField, nameField } = require("./shared");

const schema = createSchema({
  districtId: parentField("District", { immutable: true }),
  name: nameField(),
});
schema.index({ districtId: 1, publicId: 1 });
module.exports = mongoose.model("GridSubstation", schema, "grid_substations");
