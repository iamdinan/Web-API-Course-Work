const { apiBaseUrl } = require("../config/env");

function listBody(count, items, query, resource, filterKeys) {
  if (!query) return { count, items };
  function link(offset) {
    const params = new URLSearchParams();
    for (const key of filterKeys) if (query[key] !== undefined) params.set(key, query[key]);
    params.set("offset", String(offset));
    params.set("limit", String(query.limit));
    return `${apiBaseUrl}${resource}?${params}`;
  }
  return {
    count,
    next: query.offset + query.limit < count ? link(query.offset + query.limit) : null,
    previous: query.offset > 0 && count > 0 ? link(Math.max(0, query.offset - query.limit)) : null,
    items,
  };
}

module.exports = { listBody };
