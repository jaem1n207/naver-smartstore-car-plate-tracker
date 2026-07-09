# Naver Commerce API Troubleshooting

## `GW.IP_NOT_ALLOWED`

The request came from an unregistered public IP. Run live sync only from the fixed-IP server registered in Naver Commerce API settings.

## `GW.AUTHN`

The access token is invalid or expired. The client refreshes once. Repeated failures mean the signature, timestamp, client ID, client secret, or account ID needs review.

## `GW.RATE_LIMIT` or `GW.QUOTA_LIMIT`

Reduce concurrency, increase sync interval, and retry with backoff.

## Missing `originProduct.detailContent`

Verify product detail read permissions and inspect the official channel product response shape before changing extractor code.
