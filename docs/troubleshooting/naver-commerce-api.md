# Naver Commerce API Troubleshooting

## `GW.IP_NOT_ALLOWED`

The request came from an unregistered public IP. Run live sync only from the fixed-IP server registered in Naver Commerce API settings.

## `GW.AUTHN`

The access token is invalid or expired. The client refreshes once. Repeated failures mean the signature, timestamp, client ID, client secret, `SELF` application status, or server clock needs review.

## `GW.RATE_LIMIT` or `GW.QUOTA_LIMIT`

The live client serializes product detail requests, paces repeated calls from Naver's `GNCP-GW-RateLimit-Replenish-Rate` response header, and retries HTTP 429 responses with bounded exponential backoff. It honors `Retry-After` when present and otherwise waits approximately 1, 2, 4, and 8 seconds before failing the fifth attempt.

Do not repeatedly run `sync:once` after the bounded retries are exhausted. Wait at least one minute, confirm that no scheduler or other sync process is running, and try once more. Persistent failures can also indicate API-wide congestion even when a rate-limit response header reports remaining capacity.

## Missing `originProduct.detailContent`

Verify product detail read permissions and inspect the official channel product response shape before changing extractor code.
