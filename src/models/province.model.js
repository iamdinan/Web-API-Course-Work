const mongoose = require("mongoose");
const { createSchema, nameField } = require("./shared");

const schema = createSchema({ name: nameField() });
module.exports = mongoose.model("Province", schema, "provinces");
