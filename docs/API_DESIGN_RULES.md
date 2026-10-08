# API Design Rules

Common conventions for designing JSON REST APIs. Endpoint schemas, parameters and responses are documented in [OpenAPI](openapi.json).

## Resource URLs

- Use nouns for resources and plural names for collections.
- Use lowercase path segments and hyphens between words.
- Put resource identifiers in the path; use query parameters for filtering, sorting and pagination.
- Nest resources when the parent-child relationship helps explain the resource.
- Keep naming and versioning consistent across the API.

## HTTP methods

| Method | Purpose |
| --- | --- |
| GET | Retrieve a resource or collection without changing it |
| POST | Create a resource or submit an operation |
| PUT | Replace a resource |
| PATCH | Update selected fields |
| DELETE | Remove a resource |

GET should be safe. PUT and DELETE should be idempotent: repeating a request has the same intended effect, even if the response changes.

## Requests and responses

- Use JSON consistently and respect Content-Type and Accept headers.
- Validate path parameters, query parameters and request bodies. Reject unsupported fields rather than silently ignoring them.
- Document accepted fields, required values, defaults and limits.
- Use a consistent response shape for collections and errors.
- Return an empty collection with 200 rather than 404.
- Use ISO 8601 timestamps with an explicit time zone.
- Keep internal identifiers, credentials and implementation details out of public responses.

## Status codes

| Status | Meaning |
| --- | --- |
| 200 | Request succeeded |
| 201 | Resource created; include its URL in Location |
| 204 | Request succeeded with no response body |
| 304 | Conditional GET matched; no response body |
| 400 | Invalid request |
| 401 | Authentication is missing or invalid |
| 403 | Authenticated client lacks permission |
| 404 | Resource or route does not exist |
| 406 | Requested response format is unavailable |
| 409 | Request conflicts with the resource's current state |
| 412 | Request precondition failed |
| 413 | Request body is too large |
| 415 | Request media type is unsupported |
| 429 | Rate limit exceeded; include Retry-After |
| 500 | Unexpected server error |
| 503 | Service is temporarily unavailable |

Use consistent error codes and readable messages. Do not expose stack traces or sensitive data.

## Access and pagination

- Use HTTPS and validate authentication before protected operations.
- Authorize each resource before returning data, counts or cache validators.
- Apply access restrictions and filters before counting or paginating results.
- Use deterministic ordering and bounded page sizes. Preserve filters and sorting in pagination links.
- Apply rate limits consistently across server instances.

## Conditional requests

- Use stable ETags for representations and Last-Modified only when a reliable modification time exists.
- Check access before evaluating conditional requests.
- Give If-None-Match precedence over If-Modified-Since.
- Compare If-Match using strong validators and evaluate write preconditions atomically with the mutation.
- Set cache policies explicitly, especially for authenticated responses and sensitive data.

## Documentation

Keep OpenAPI aligned with implemented behavior. Document endpoint-specific exceptions there rather than adding them to these common rules.
