const { User } = require("../../models");
const { signAccessToken } = require("../../services/access-tokens");
const { currentUserPrincipal } = require("../../services/user-principal");
const { verifyPassword } = require("../../services/passwords");

async function issueUserToken(email, password) {
  const user = await User.findOne({ email }).select("publicId role readScope provinceId districtId +passwordHash").lean();
  // Unknown users and invalid stored hash formats still perform password derivation.
  if (!await verifyPassword(password, user?.passwordHash)) return null;
  const principal = currentUserPrincipal(user);
  if (!principal) throw new Error("Invalid stored user authorization.");
  const { id, ...authorization } = principal;
  const claims = { actor: "user", ...authorization };
  return { ...signAccessToken(id, claims), userId: id };
}

module.exports = { issueUserToken };
