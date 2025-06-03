export default {
  async fetch(request, env, ctx) {
    // This 'fetch' handler path is primarily for direct HTTP requests.
    // Cloudflare Workers scheduled events primarily use the 'scheduled' handler.
    if (request.headers.get('user-agent')?.includes('Cloudflare-Workers') && request.method === 'GET') {
      console.log('Worker received HTTP request from Cloudflare-Workers (likely internal or testing cron via HTTP).');
      try {
        await this.synchronizeDNSRecords(env);
        return new Response('Worker executed by scheduled trigger via HTTP. DNS records updated.', { status: 200 });
      } catch (error) {
        console.error('Error during scheduled HTTP execution:', error);
        return new Response(`Error during scheduled HTTP execution: ${error.message}`, { status: 500 });
      }
    }

    // Handle direct HTTP GET requests (e.g., from targetsinternaldns.jdores.xyz)
    if (request.method === 'GET') {
      console.log('Worker triggered by direct HTTP GET request.');
      try {
        // Run the synchronization logic
        await this.synchronizeDNSRecords(env);
        // After synchronization, fetch and return the current state of DNS records
        const dnsRecords = await this.getDNSRecords(env);
        return new Response(JSON.stringify(dnsRecords, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.error('Error handling direct HTTP request:', error);
        return new Response(`Error: ${error.message}`, { status: 500 });
      }
    }

    // For any other methods or paths not explicitly handled
    return new Response('Method Not Allowed or Invalid Path', { status: 405 });
  },

  async scheduled(event, env, ctx) {
    console.log('Worker triggered by cron schedule (scheduled event).');
    try {
      await this.synchronizeDNSRecords(env);
      console.log('DNS synchronization completed successfully by cron.');
    } catch (error) {
      console.error('Error during scheduled DNS synchronization:', error);
      // In a scheduled event, you might want to log errors to a service like Sentry or Cloudflare's own analytics.
    }
  },

  /**
   * Main function to synchronize target hostnames and IPs with Cloudflare DNS records.
   * This function is called by both HTTP fetch and scheduled cron events.
   * @param {object} env The environment variables and secrets.
   */
  async synchronizeDNSRecords(env) {
    const { CLOUDFLARE_ZONE_ID, DNS_SUFFIX, ACCOUNT_ID, USER_EMAIL, API_KEY } = env;

    if (!ACCOUNT_ID || !USER_EMAIL || !API_KEY) {
      throw new Error('Cloudflare API credentials (ACCOUNT_ID, USER_EMAIL, API_KEY) are not set as secrets. Please configure them using `wrangler secret put`.');
    }

    console.log('Starting DNS synchronization process...');

    // 1. Fetch current targets from the infrastructure API
    const targets = await this.fetchTargets(ACCOUNT_ID, USER_EMAIL, API_KEY);
    console.log(`Successfully fetched ${targets.length} targets.`);

    // 2. Fetch existing A records in the internal DNS zone that match our suffix
    const existingDnsRecords = await this.getDNSRecords(env);
    const relevantExistingDnsRecords = existingDnsRecords.filter(
      (record) => record.type === 'A' && record.name.endsWith(`.${DNS_SUFFIX}`)
    );
    console.log(`Found ${relevantExistingDnsRecords.length} existing relevant A records.`);

    // 3. Determine necessary DNS changes (add, update, delete operations)
    const { posts, deletes } = this.determineDnsBatchOperations(
      targets,
      relevantExistingDnsRecords,
      DNS_SUFFIX
    );

    // 4. Apply batch DNS changes if there are any operations
    if (posts.length > 0 || deletes.length > 0) {
      console.log(`Applying DNS batch operations: ${posts.length} posts, ${deletes.length} deletes.`);
      await this.batchUpdateDNSRecords(CLOUDFLARE_ZONE_ID, USER_EMAIL, API_KEY, posts, deletes);
      console.log('DNS batch update completed.');
    } else {
      console.log('No DNS changes required. Records are already in sync.');
    }
  },

  /**
   * Fetches the list of infrastructure targets from the Cloudflare API.
   * @param {string} accountId The Cloudflare Account ID.
   * @param {string} userEmail The Cloudflare API user email.
   * @param {string} apiKey The Cloudflare API Key.
   * @returns {Promise<Array<Object>>} A promise that resolves to an array of target objects.
   */
  async fetchTargets(accountId, userEmail, apiKey) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/infrastructure/targets`;
    const headers = {
      'X-Auth-Email': userEmail,
      'X-Auth-Key': apiKey,
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, { headers });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to fetch targets: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
    }
    const data = await response.json();
    // Filter for targets with valid IPv4 addresses
    return data.result.filter(target => target.ip && target.ip.ipv4 && target.ip.ipv4.ip_addr);
  },

  /**
   * Fetches all DNS records for a given zone.
   * @param {object} env The environment variables and secrets containing zone ID and API credentials.
   * @returns {Promise<Array<Object>>} A promise that resolves to an array of DNS record objects.
   */
  async getDNSRecords(env) {
    const { CLOUDFLARE_ZONE_ID, USER_EMAIL, API_KEY } = env;
    const url = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/`;
    const headers = {
      'X-Auth-Email': USER_EMAIL,
      'X-Auth-Key': API_KEY,
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, { headers });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to fetch DNS records: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
    }
    const data = await response.json();
    return data.result;
  },

  /**
   * Determines the necessary batch operations (posts and deletes) for DNS records.
   * An "update" is handled as a delete of the old record and a post of the new one.
   * @param {Array<Object>} targets List of infrastructure targets.
   * @param {Array<Object>} existingDnsRecords List of existing DNS records in the zone.
   * @param {string} dnsSuffix The suffix to append to hostnames for DNS records.
   * @returns {{posts: Array<Object>, deletes: Array<Object>}} An object containing arrays for new/updated records and records to be deleted.
   */
  determineDnsBatchOperations(targets, existingDnsRecords, dnsSuffix) {
    const posts = []; // For new records or new versions of updated records
    const deletes = []; // For records to be removed or old versions of updated records

    // Create maps for efficient lookup
    const targetMap = new Map(); // Key: target_hostname.srv.jdores.internal, Value: target_ipv4_address
    targets.forEach(target => {
      if (target.hostname && target.ip?.ipv4?.ip_addr) {
        targetMap.set(`${target.hostname}.${dnsSuffix}`, target.ip.ipv4.ip_addr);
      }
    });

    // Create a mutable map of existing DNS records to track what needs to be deleted
    const existingDnsMap = new Map(); // Key: dns_record_name, Value: { id: dns_record_id, content: dns_record_content }
    existingDnsRecords.forEach(record => {
      existingDnsMap.set(record.name, { id: record.id, content: record.content });
    });

    // Iterate through targets to find new records or records that need updating
    for (const [targetDnsName, targetIp] of targetMap.entries()) {
      if (existingDnsMap.has(targetDnsName)) {
        const existingRecord = existingDnsMap.get(targetDnsName);
        if (existingRecord.content !== targetIp) {
          // Record exists but IP address has changed: Mark old for DELETE, new for POST
          console.log(`DNS Change: Updating ${targetDnsName} from ${existingRecord.content} to ${targetIp}`);
          deletes.push({ id: existingRecord.id, name: targetDnsName }); // Need name for logging/debugging, though API only needs ID
          posts.push({
            type: 'A',
            name: targetDnsName,
            content: targetIp,
            ttl: 3600, // Standard TTL, adjust if needed
            proxied: false, // Internal DNS, typically not proxied
          });
        }
        // If content is the same, no action needed for this record.
        // Remove from existingDnsMap so it's not considered for deletion later.
        existingDnsMap.delete(targetDnsName);
      } else {
        // New record: Mark for POST
        console.log(`DNS Change: Adding new record ${targetDnsName} with IP ${targetIp}`);
        posts.push({
          type: 'A',
          name: targetDnsName,
          content: targetIp,
          ttl: 3600, // Standard TTL, adjust if needed
          proxied: false, // Internal DNS, typically not proxied
        });
      }
    }

    // Any records remaining in existingDnsMap are stale and should be deleted
    for (const [existingDnsName, existingRecord] of existingDnsMap.entries()) {
      console.log(`DNS Change: Deleting stale record ${existingDnsName} (ID: ${existingRecord.id})`);
      deletes.push({ id: existingRecord.id, name: existingDnsName });
    }

    return { posts, deletes };
  },

  /**
   * Executes a batch of DNS record operations (add and delete) via the Cloudflare API.
   * @param {string} zoneId The Cloudflare Zone ID.
   * @param {string} userEmail The Cloudflare API user email.
   * @param {string} apiKey The Cloudflare API Key.
   * @param {Array<Object>} posts An array of DNS record objects to create/update.
   * @param {Array<Object>} deletes An array of objects with { id: recordId } to delete.
   * @returns {Promise<Object>} A promise that resolves to the API response.
   */
  async batchUpdateDNSRecords(zoneId, userEmail, apiKey, posts, deletes) {
    if (posts.length === 0 && deletes.length === 0) {
      console.log('No DNS batch operations to perform.');
      return;
    }

    const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/batch`;
    const headers = {
      'X-Auth-Email': userEmail,
      'X-Auth-Key': apiKey,
      'Content-Type': 'application/json',
    };

    const payload = {
      posts: posts,
      deletes: deletes,
    };

    console.log('Sending batch DNS update payload:', JSON.stringify(payload, null, 2));

    const response = await fetch(url, {
      method: 'POST', // The batch endpoint itself is always POST
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Batch DNS update failed:', JSON.stringify(errorData, null, 2));
      throw new Error(`Failed to batch update DNS records: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    console.log('Batch DNS update successful:', JSON.stringify(data, null, 2));
    // 'data.result' will contain information about the success of individual posts/deletes.
    return data;
  },
};