// Entity-tag syntax: opaque quoted bytes, optionally weak, or a sole wildcard.
// Weak tags are valid syntax but never satisfy a strong If-Match comparison.
function parseIfMatch(header) {
  if (header === undefined) return null;
  if (typeof header !== "string") throw new Error("Invalid If-Match syntax.");
  const value = header.trim();
  if (value === "*") return { wildcard: true, tags: [] };
  const tags = [];
  let rest = value;
  while (rest) {
    const match = /^(W\/)?"[\x21\x23-\x7e\x80-\xff]*"/.exec(rest);
    if (!match) throw new Error("Invalid If-Match syntax.");
    if (!match[1]) tags.push(match[0]);
    rest = rest.slice(match[0].length).replace(/^[ \t]+/, "");
    if (!rest) return { wildcard: false, tags };
    if (rest[0] !== ",") throw new Error("Invalid If-Match syntax.");
    rest = rest.slice(1).replace(/^[ \t]+/, "");
    if (!rest) throw new Error("Invalid If-Match syntax.");
  }
  throw new Error("Invalid If-Match syntax.");
}

function ifMatchAllows(condition, currentTag) {
  return condition === null || condition.wildcard || condition.tags.includes(currentTag);
}
module.exports = { parseIfMatch, ifMatchAllows };
