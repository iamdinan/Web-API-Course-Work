const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const { colomboTimestamp } = require("../utils/timestamps");
const { publicUuid } = require("../services/user-principal");

function uuidField(options = {}) {
  return { type: String, required: true, match: publicUuid, ...options };
}

function parentField(modelName, options = {}) {
  return uuidField({
    ...options,
    validate: {
      async validator(value) {
        if (value == null) return true;
        const Model = mongoose.models[modelName] || require("./index")[modelName];
        const session = this instanceof mongoose.Document ? this.$session() : this.getOptions().session;
        return Boolean(await Model.exists({ publicId: value }).session(session || null));
      },
      message: `${modelName} must exist.`,
    },
  });
}

function createSchema(fields) {
  const schema = new mongoose.Schema({
    publicId: uuidField({ default: randomUUID, immutable: true }),
    ...fields,
  }, {
    id: false,
    strict: "throw",
    toJSON: {
      transform(doc, result) {
        result.id = result.publicId;
        delete result.publicId;
        delete result._id;
        delete result.__v;
        delete result.deviceCredentialHash;
        delete result.passwordHash;
        delete result._ingestionLock;
        for (const field of ["recordedAt", "receivedAt"]) {
          if (result[field] instanceof Date) {
            // Preserve the instant while displaying Asia/Colombo (UTC+05:30).
            result[field] = colomboTimestamp(result[field]);
          }
        }
        return result;
      },
    },
  });
  schema.index({ publicId: 1 }, { unique: true });
  return schema;
}

const nameField = () => ({ type: String, required: true, trim: true, minlength: 1 });
const hashField = () => ({ type: String, required: true, select: false, minlength: 1 });

module.exports = { createSchema, parentField, nameField, hashField };
