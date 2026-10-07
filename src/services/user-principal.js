const publicUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function currentUserPrincipal(user) {
  if (!user || !publicUuid.test(user.publicId) || !["user", "admin"].includes(user.role)) return null;
  const province = user.provinceId != null;
  const district = user.districtId != null;
  const validScope = (user.readScope === "national" && !province && !district) ||
    (user.readScope === "province" && province && !district && publicUuid.test(user.provinceId)) ||
    (user.readScope === "district" && district && !province && publicUuid.test(user.districtId));
  if (!validScope || (user.role === "admin" && user.readScope !== "national")) return null;
  const principal = { id: user.publicId, role: user.role, readScope: user.readScope };
  if (province) principal.provinceId = user.provinceId;
  if (district) principal.districtId = user.districtId;
  if (user.role === "admin") principal.permissions = Object.freeze(["installation-create", "installation-deactivate", "installation-delete"]);
  return Object.freeze(principal);
}

module.exports = { currentUserPrincipal, publicUuid };
