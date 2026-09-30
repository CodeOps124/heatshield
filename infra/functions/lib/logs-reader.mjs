/**
 * Reading CloudWatch Logs for Otto, without the SDK (aws.mjs passes the two calls in), so the paging
 * rules are unit-tested.
 *
 * FilterLogEvents searches a log group stream by stream, and a page can be empty while more events
 * exist. AWS: "Partially full or empty pages don't necessarily mean that pagination is finished." On
 * 30 Sep, sampling read only the first page, which came back empty: Otto counted 10 failed calls to
 * the primary model but could not read why, and called a known setup state (the Anthropic use-case
 * form not yet submitted) a failing model, marking the site degraded.
 */
const MAX_PAGES = 5;

/** Keeps only non-sensitive fields of a structured log line. */
export function sanitizeLogLine(message) {
  const text = String(message ?? '').trim();
  const brace = text.indexOf('{');
  if (brace !== -1) {
    try {
      const j = JSON.parse(text.slice(brace));
      const keep = ['level', 'msg', 'message', 'error', 'name', 'route', 'modelId', 'code'];
      return JSON.stringify(Object.fromEntries(keep.filter((k) => j[k] !== undefined).map((k) => [k, String(j[k]).slice(0, 200)])));
    } catch { /* not JSON */ }
  }
  return text.slice(0, 240);
}

/**
 * @param {Function} filterLogEvents   (params) -> FilterLogEvents response
 * @param {Function} describeLogGroups (params) -> DescribeLogGroups response
 */
export function createLogsReader({ filterLogEvents, describeLogGroups }) {
  /** Every matching event since `startMs`, across pages (capped), oldest first. */
  async function filterAll(params) {
    const events = [];
    let nextToken;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await filterLogEvents({ ...params, nextToken });
      events.push(...(res.events ?? []));
      nextToken = res.nextToken;
      if (!nextToken) break;
    }
    return events.sort((a, b) => a.timestamp - b.timestamp);
  }

  return {
    /** Names of log groups starting with `prefix`. */
    async listGroups(prefix) {
      const names = [];
      let nextToken;
      do {
        const res = await describeLogGroups({ logGroupNamePrefix: prefix, nextToken });
        names.push(...(res.logGroups ?? []).map((g) => g.logGroupName));
        nextToken = res.nextToken;
      } while (nextToken);
      return names;
    },
    /** Count matching log events since `startMs` (capped at 5 pages of 1,000). */
    count: async (logGroupName, filterPattern, startMs) =>
      (await filterAll({ logGroupName, filterPattern, startTime: startMs, limit: 1000 })).length,
    /** The most recent matching lines, reduced to non-sensitive fields. */
    sample: async (logGroupName, filterPattern, startMs, limit = 8) =>
      (await filterAll({ logGroupName, filterPattern, startTime: startMs, limit: 50 })).slice(-limit)
        .map((e) => ({ at: new Date(e.timestamp).toISOString(), line: sanitizeLogLine(e.message) })),
  };
}
