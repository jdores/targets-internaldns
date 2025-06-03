## Cloudflare worker to synchronize the zero trust target list with Cloudflare internal DNS

This worker can be used to make sure that the targets list within the zero trust dashboard is always synchronized to a cloudflare internal dns zone. 
The worker can be triggered on demand by accessing it at its custom domain and it also runs according to the cron schedule set in wrangler.jsonc.

### Installation instructions

1. Create an internal zone using the Cloudflare API. Save its id.
2. Associate this internal zone with an internal view using the Cloudflare API, so it can be used in Gateway Resolver Policies
3. Add target on the zero trust dashboard with IPv4 addresses
4. Adjust the wrangler.jsonc file it the desired cron schedule, the id of the zone created in step 1. The DNS suffix will determine the full name for the target: {targethostname}.{dnsuffix}
5. In your worker project set the following variables as secrets:
- ACCOUNT_ID : your Cloudflare account id
- USER_EMAIL : your account email
- API_KEY : the API key associated with your account email
6. Create a Cloudflare Access Policy restricting access to the worker custom domain..