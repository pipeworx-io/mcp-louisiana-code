interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}


/**
 * HTML-to-text helpers shared by the state statute packs.
 *
 * One decoder rather than one per pack, because the copies had already begun
 * to drift: the hex-entity case (&#x2003; em space, &#x2014; em dash) was
 * handled in Florida's copy and not California's, so Californian statutes were
 * quietly emitting raw entities where punctuation belonged. Fixed once here.
 *
 * publish-pack.sh inlines workspace imports, so a standalone pack still ships
 * self-contained.
 */

const SCRIPT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK = /<\/?(p|div|br|tr|li|h[1-6]|blockquote)\b[^>]*>/gi;

/** Convert a slice of statute HTML to readable plain text. */
function statuteText(html: string): string {
  return html
    .replace(/\r\n?/g, '\n')
    .replace(SCRIPT, ' ')
    .replace(BLOCK, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // Hex before decimal: legislature sites emit &#x2003; and &#x2014;
    // constantly, and a decimal-only decoder leaves them in the middle of the
    // statute looking like markup noise.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&sect;/g, '\u00a7')
    // Named entities that carry MEANING, decoded before the catch-all below.
    // This was a real defect: the catch-all replaced &ndash; with a SPACE, so
    // Maryland's "&sect;2&ndash;201." decoded to "2 201" and a lookup for
    // section 2-201 reported a statute that plainly exists as missing. Dashes
    // are everywhere in statutory text and numbering, so the corruption was
    // silent and general rather than particular to one state.
    .replace(/&ndash;/g, '\u2013')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&rsquo;|&apos;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&ldquo;/g, '\u201c')
    .replace(/&rdquo;/g, '\u201d')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Text from a container, starting AFTER its opening tag.
 *
 * Slicing at the marker itself leaves the tail of the tag — `laws-body">` — as
 * the first characters of the statute, which is exactly what three packs did
 * before testing caught it.
 */
function textFromContainer(html: string, marker: string | RegExp): string | null {
  const i = typeof marker === 'string' ? html.indexOf(marker) : html.search(marker);
  if (i === -1) return null;
  const gt = html.indexOf('>', i);
  return statuteText(html.slice(gt === -1 ? i : gt + 1));
}

/**
 * Read a statute response as text, honouring its actual encoding.
 *
 * Several state sites serve WINDOWS-1252 while sending `content-type:
 * text/html` with no charset. Response.text() assumes UTF-8, so their smart
 * quotes and non-breaking spaces decode to replacement characters — Nevada
 * rendered `"Murder" defined` as mojibake, and Oregon's section headings
 * became unmatchable because the "space" after the section number is a 0xA0
 * that never survived the decode.
 *
 * That is the quiet kind of damage: the text still looks like text, so nothing
 * errors, and a heading regex simply stops matching for reasons no one can see
 * in the output.
 *
 * Strict UTF-8 first — if the bytes really are UTF-8 this succeeds and nothing
 * changes — then fall back to windows-1252, which decodes every byte and so
 * cannot itself fail.
 */
async function readStatuteResponse(res: Response): Promise<string> {
  const buf = await res.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/**
 * Cut one section out of a page that holds a whole chapter.
 *
 * A section number appears several times on these pages and only one of them
 * starts the statute. The others are a table-of-contents entry at the top and
 * cross-references inside neighbouring sections. Picking the FIRST match
 * returns a heading with nothing under it; picking the LAST returns whatever
 * fragment follows a cross-reference. Both were tried and both produced
 * confident, tiny, wrong answers — Oregon 140 characters, Nevada 39, each
 * looking like a real result.
 *
 * The body is simply the candidate with the most text before the next section
 * begins, which is true regardless of where the page puts its contents list.
 *
 * @param heading matches the start of the wanted section (global flag required)
 * @param next    matches the start of ANY section, to bound the slice
 */
function sliceSection(text: string, heading: RegExp, next: RegExp): string | null {
  // Record where each candidate starts AND how long its heading is. Skipping
  // only one character past the start lets the  pattern re-match the very
  // heading we just found, which yields an empty body — that bug returned
  // section_not_found for a section plainly present on the page.
  const found: Array<{ at: number; len: number }> = [];
  const re = new RegExp(heading.source, heading.flags.includes('g') ? heading.flags : heading.flags + 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    found.push({ at: m.index, len: m[0].length });
    if (re.lastIndex === m.index) re.lastIndex++;   // guard zero-width matches
  }
  if (!found.length) return null;

  let best: string | null = null;
  for (const { at, len } of found) {
    const from = at + len;
    const nre = new RegExp(next.source, next.flags.includes('g') ? next.flags : next.flags + 'g');
    const m = nre.exec(text.slice(from));
    const body = (m ? text.slice(at, from + m.index) : text.slice(at)).trim();
    if (body.length > (best?.length ?? 0)) best = body;
  }
  return best && best.length > 0 ? best : null;
}
/**
 * Louisiana Laws — Revised Statutes, Civil Code, Code of Civil Procedure,
 * Code of Criminal Procedure, Code of Evidence, Children's Code and the
 * Louisiana Constitution — section by citation with its enactment and
 * amendment history parsed out, full-text topic search across all of those
 * code bodies, and a browse of every section in one Revised Statutes title.
 *
 * SOURCE: the Louisiana State Legislature's own law site, legis.la.gov
 * (IIS / ASP.NET WebForms). Keyless, no cookie, no CAPTCHA, no JavaScript
 * needed. There is no Lexis hop anywhere in it — the text is served by the
 * legislature itself.
 *
 * SHAPE OF THE SOURCE, verified live 2026-10-07, because it is a form rather
 * than a REST API:
 *
 *   - A section page is a plain GET: Law.aspx?d=<doc_id>. The citation sits
 *     in <span id="ctl00_PageBody_LabelName">, the body in
 *     <span id="ctl00_PageBody_LabelDocument"> as <P> paragraphs whose LAST
 *     paragraph is the history line ("Added by Acts 1976, No. 655, §1.
 *     Amended by Acts 1977, No. 392, §1; ...").
 *   - Doc ids are NOT in citation order (d=78337 is RS 14:2, d=78338 is
 *     RS 14:20, d=78339 is RS 14:201 — string-sorted), so a citation cannot
 *     be turned into a doc id arithmetically. The site's "View a Specific
 *     Law" form does it: POST the form's hidden __VIEWSTATE fields plus the
 *     law body, title and section, and the server answers 302 to
 *     Law.aspx?d=<id>. An unknown citation re-renders the form with no
 *     redirect, which is the not-found signal.
 *   - Full-text search is the same form, cross-page-posted to
 *     LawSearchList.aspx with the per-body checkboxes. Results are
 *     server-rendered rows (<a href="law.aspx?d=N">RS 14:20</a>, heading,
 *     "Last Modified mm/dd/yyyy"), relevance-sorted, first 100 of N with
 *     the total stated. The "Select All" checkbox is client-side JavaScript
 *     only — the server honours the ten individual boxes, so "all bodies"
 *     means ticking all ten.
 *   - A Revised Statutes title's contents come from the Table of Contents
 *     page via a LinkButton postback (ListViewTOC1$ctrlN) — one request
 *     returns every section of the title with its heading.
 *   - The __VIEWSTATE is not session-bound: one GET of the form supplies
 *     hidden fields that stay valid for repeated POSTs, so the pack caches
 *     them per isolate and a warm citation lookup is one POST + one GET.
 *
 * WHAT THE SOURCE CANNOT DO: it serves the CURRENT compiled text only. A
 * point-in-time prior version of a section is not available here, and every
 * section response says so in `historical_version` rather than omitting it.
 * The amendment history IS available (the trailing Acts line) and is parsed
 * into `history` / `amendments`.
 */

const ORIGIN = 'https://legis.la.gov';
const FORM_URL = `${ORIGIN}/Legis/LawSearch.aspx`;
const SEARCH_LIST_URL = `${ORIGIN}/Legis/LawSearchList.aspx`;
const TOC_URL = `${ORIGIN}/Legis/Laws_Toc.aspx?folder=75&level=Parent`;
const UA = 'pipeworx-mcp-louisiana-code/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'Louisiana State Legislature (legis.la.gov)';
const P = 'ctl00$ctl00$PageBody$PageContent$';
const FORM_TTL_MS = 30 * 60 * 1000;

async function pwFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, UPSTREAM);
}

/* ------------------------------------------------------------------ */
/* Law bodies                                                          */
/* ------------------------------------------------------------------ */

interface Body {
  code: string;
  name: string;
  /** index of the body's checkbox on the search form */
  box: number;
  /** two-number citation (title:section / article:section) vs one article number */
  twoPart: boolean;
  /** how a citation is rendered back */
  cite: (a: string, b?: string) => string;
  /** whether the "View a Specific Law" form supports it (rules do not) */
  lookup: boolean;
}

const BODIES: Record<string, Body> = {
  RS: { code: 'RS', name: 'Revised Statutes', box: 9, twoPart: true, lookup: true,
    cite: (a, b) => `RS ${a}:${b}` },
  CC: { code: 'CC', name: 'Civil Code', box: 1, twoPart: false, lookup: true,
    cite: (a) => `CC ${a}` },
  CCP: { code: 'CCP', name: 'Code of Civil Procedure', box: 2, twoPart: false, lookup: true,
    cite: (a) => `CCP ${a}` },
  CCRP: { code: 'CCRP', name: 'Code of Criminal Procedure', box: 3, twoPart: false, lookup: true,
    cite: (a) => `CCRP ${a}` },
  CE: { code: 'CE', name: 'Code of Evidence', box: 4, twoPart: false, lookup: true,
    cite: (a) => `CE ${a}` },
  CHC: { code: 'CHC', name: "Children's Code", box: 0, twoPart: false, lookup: true,
    cite: (a) => `CHC ${a}` },
  CONST: { code: 'CONST', name: 'Louisiana Constitution', box: 6, twoPart: true, lookup: true,
    cite: (a, b) => `CONST ${a}:${b}` },
  CA: { code: 'CA', name: 'Constitution Ancillaries', box: 5, twoPart: true, lookup: false,
    cite: (a, b) => `CA ${a}:${b}` },
  HRULE: { code: 'HRULE', name: 'House Rules', box: 7, twoPart: true, lookup: false,
    cite: (a, b) => `HRULE ${a}:${b}` },
  SRULE: { code: 'SRULE', name: 'Senate Rules', box: 10, twoPart: true, lookup: false,
    cite: (a, b) => `SRULE ${a}:${b}` },
  JRULE: { code: 'JRULE', name: 'Joint Rules', box: 8, twoPart: true, lookup: false,
    cite: (a, b) => `JRULE ${a}:${b}` },
};
const SEARCH_BODY_CODES = Object.keys(BODIES);

/** Loose prefixes people actually type, normalised (letters only). */
const PREFIX_TO_BODY: Record<string, string> = {
  '': 'RS', rs: 'RS', revstat: 'RS', revisedstatute: 'RS', revisedstatutes: 'RS', larevstat: 'RS',
  cc: 'CC', civcode: 'CC', civilcode: 'CC',
  ccp: 'CCP', codeofcivilprocedure: 'CCP', codecivproc: 'CCP', ccpr: 'CCP',
  ccrp: 'CCRP', ccrp_: 'CCRP', crp: 'CCRP', codeofcriminalprocedure: 'CCRP', codecrimproc: 'CCRP',
  ce: 'CE', codeofevidence: 'CE', codeevid: 'CE',
  chc: 'CHC', childrenscode: 'CHC', chcode: 'CHC',
  const: 'CONST', constitution: 'CONST', laconst: 'CONST', louisianaconstitution: 'CONST',
};

function romanToInt(s: string): number | null {
  const map: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  const t = s.toLowerCase();
  if (!/^[ivxlc]+$/.test(t)) return null;
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const cur = map[t[i]];
    const next = map[t[i + 1]] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

interface ParsedCitation { body: Body; first: string; second?: string; display: string }

/**
 * Accepts the forms a caller is likely to paste: "RS 14:20", "La. R.S. 14:20",
 * "14:20", "CC 2315", "La. C.C. art. 2315", "Civil Code art. 2315",
 * "CCP 966", "C.Cr.P. art. 701", "CE 404", "Ch.C. art. 603",
 * "Const. Art. I, §5", "CONST 1:5".
 */
function parseCitation(raw: string): ParsedCitation | null {
  let s = raw.trim().replace(/\s+/g, ' ').replace(/^la\.?\s*/i, '').replace(/^louisiana\s+/i, '');
  s = s.replace(/§/g, ' ').replace(/\s+/g, ' ').trim();
  const firstDigit = s.search(/\d/);
  if (firstDigit === -1) return null;
  let prefix = s.slice(0, firstDigit);
  const rest = s.slice(firstDigit).replace(/\s+/g, '');

  // Constitution with a roman article: "Const. Art. I, §5" / "Const Art I Sec 5"
  const constRoman = /^const(?:itution)?\.?\s*art(?:icle)?\.?\s*([ivxlc]+)\b[\s,:.]*(?:sec(?:tion)?\.?)?\s*$/i.exec(prefix);
  if (constRoman) {
    const art = romanToInt(constRoman[1]);
    const sec = /^(\d+)$/.exec(rest);
    if (art && sec) {
      const body = BODIES.CONST;
      return { body, first: String(art), second: sec[1], display: body.cite(String(art), sec[1]) };
    }
    return null;
  }

  prefix = prefix.replace(/\b(art(?:icle)?|sec(?:tion)?|no)\b\.?/gi, ' ');
  const key = prefix.toLowerCase().replace(/[^a-z]/g, '');
  const code = PREFIX_TO_BODY[key];
  if (!code) return null;
  const body = BODIES[code];

  if (body.twoPart) {
    // "14:20", "14:2800.1", "1:5", or Constitution "1,5" / "1-5"
    const m = /^(\d+)[:,\-](\d+(?:\.\d+)*[A-Za-z]?)$/.exec(rest);
    if (!m) return null;
    return { body, first: m[1], second: m[2], display: body.cite(m[1], m[2]) };
  }
  const m = /^(\d+(?:\.\d+)*[A-Za-z]?)$/.exec(rest);
  if (!m) return null;
  return { body, first: m[1], display: body.cite(m[1]) };
}

/* ------------------------------------------------------------------ */
/* The ASP.NET form                                                    */
/* ------------------------------------------------------------------ */

interface FormState { fields: Record<string, string>; currentThrough: string | null; at: number }

const formCache = new Map<string, FormState>();

function hiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<input[^>]*type="hidden"[^>]*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const name = /name="([^"]+)"/.exec(m[0]);
    const value = /value="([^"]*)"/.exec(m[0]);
    if (name) out[name[1]] = value ? decodeAttr(value[1]) : '';
  }
  return out;
}

function decodeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function currentThroughOf(html: string): string | null {
  const m = /updated through the\s*(?:<[^>]*>\s*)*([^<.]+?)\s*(?:<|\.)/i.exec(html);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function encodeForm(fields: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) p.append(k, v);
  return p.toString(); // "$" becomes %24, which is what IIS expects
}

async function postForm(url: string, fields: Record<string, string>): Promise<Response> {
  return pwFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: FORM_URL },
    body: encodeForm(fields),
    redirect: 'manual',
  });
}

/**
 * The form's hidden fields for a given law body. For RS the fresh GET is
 * already in the right state; for every other body the dropdown's own
 * postback has to run once so the server-side state (and the box hints)
 * switch to that body. Cached per isolate; `force` bypasses the cache after
 * a POST that came back without a redirect, in case the viewstate aged out.
 */
async function formFor(bodyCode: string, force = false): Promise<FormState> {
  const cached = formCache.get(bodyCode);
  if (cached && !force && Date.now() - cached.at < FORM_TTL_MS) return cached;

  const res = await pwFetch(FORM_URL);
  if (!res.ok) throw new Error(`${UPSTREAM} returned HTTP ${res.status} for the law search form`);
  const html = await readStatuteResponse(res);
  let fields = hiddenFields(html);
  if (!fields.__VIEWSTATE) throw new Error(`${UPSTREAM} law search form had no __VIEWSTATE — page shape changed`);
  const currentThrough = currentThroughOf(html);

  if (bodyCode !== 'RS') {
    const switched = await postForm(FORM_URL, {
      ...fields,
      __EVENTTARGET: `${P}ddlLawBodies`,
      __EVENTARGUMENT: '',
      [`${P}ddlLawBodies`]: bodyCode,
      [`${P}tbFirstNumber`]: ' Title',
      [`${P}tbSecondNumber`]: ' Section',
    });
    if (switched.status !== 200) throw new Error(`${UPSTREAM} returned HTTP ${switched.status} switching the form to ${bodyCode}`);
    fields = hiddenFields(await readStatuteResponse(switched));
    if (!fields.__VIEWSTATE) throw new Error(`${UPSTREAM} form switch to ${bodyCode} returned no __VIEWSTATE`);
  }
  const state = { fields, currentThrough, at: Date.now() };
  formCache.set(bodyCode, state);
  return state;
}

function docIdFromRedirect(res: Response): string | null {
  if (res.status < 300 || res.status >= 400) return null;
  const loc = res.headers.get('location') ?? '';
  const m = /law\.aspx\?d=(\d+)/i.exec(loc);
  return m ? m[1] : null;
}

/** citation -> doc id via the "View a Specific Law" form, or null when the site does not know it. */
async function resolveDocId(c: ParsedCitation): Promise<{ docId: string | null; currentThrough: string | null }> {
  for (const attempt of [0, 1]) {
    const form = await formFor(c.body.code, attempt === 1);
    const fields: Record<string, string> = {
      ...form.fields,
      __EVENTTARGET: '',
      __EVENTARGUMENT: '',
      [`${P}ddlLawBodies`]: c.body.code,
      [`${P}tbFirstNumber`]: c.first,
      [`${P}btnViewLaw`]: 'View',
    };
    if (c.body.twoPart) fields[`${P}tbSecondNumber`] = c.second ?? '';
    const res = await postForm(FORM_URL, fields);
    const docId = docIdFromRedirect(res);
    if (docId) return { docId, currentThrough: form.currentThrough };
    if (res.status === 200) {
      // The form re-rendered: either the citation is unknown, or (attempt 0
      // only) the cached viewstate aged out. One forced refresh settles it.
      await res.arrayBuffer().catch(() => undefined);
      if (attempt === 1) return { docId: null, currentThrough: form.currentThrough };
      continue;
    }
    throw new Error(`${UPSTREAM} returned HTTP ${res.status} resolving ${c.display}`);
  }
  return { docId: null, currentThrough: null };
}

/* ------------------------------------------------------------------ */
/* Section page                                                        */
/* ------------------------------------------------------------------ */

const HISTORY_LINE = /^(Added by |Amended by |Acts \d{4}|Enacted by |Reenacted by |Redesignated |Renumbered |Repealed by |Redesignated from |Added by Acts|Acts \d{4},)/i;
const HEADING_LINE = /^(§\s*[\dA-Za-z.]+|Art(?:icle)?\.\s*[\dA-Za-z.]+|Section\s+[\dA-Za-z.]+|Rule\s+[\dA-Za-z.]+)[.\s]/;

interface Amendment { year: number; act: number; session: string | null }

function parseAmendments(history: string): Amendment[] {
  const out: Amendment[] = [];
  const re = /Acts\s+(\d{4})(?:,\s*(\d+(?:st|nd|rd|th)\s+Ex(?:tra)?(?:ordinary)?\.?\s*Sess(?:ion)?\.?))?,\s*No\.\s*(\d+)/gi;
  for (let m = re.exec(history); m; m = re.exec(history)) {
    out.push({ year: Number(m[1]), act: Number(m[3]), session: m[2] ? m[2].replace(/\s+/g, ' ').trim() : null });
  }
  return out;
}

interface Section {
  citation: string;
  heading: string | null;
  hierarchy: string[];
  text: string;
  history: string | null;
  amendments: Amendment[];
}

function parseSectionPage(html: string): Section | null {
  const nameM = /id="ctl00_PageBody_LabelName"[^>]*>([^<]*)</.exec(html);
  const docM = /<span id="ctl00_PageBody_LabelDocument">([\s\S]*?)<\/span>\s*<\/div>/.exec(html);
  if (!nameM || !docM) return null;
  const citation = statuteText(nameM[1]).trim();
  // Split on the page's own <P> boundaries, not on newlines: the source
  // hard-wraps long paragraphs with raw line breaks (RS 14:30's history line
  // spans nine of them), and a newline split turned one history paragraph
  // into fragments of which only the first looked like history.
  const lines = docM[1]
    .split(/<\/?p\b[^>]*>/i)
    .map((p) => statuteText(p).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!lines.length) return null;

  let headingIdx = lines.findIndex((l) => HEADING_LINE.test(l));
  if (headingIdx === -1) headingIdx = 0;
  const hierarchy = lines.slice(0, headingIdx);
  const heading = lines[headingIdx] ?? null;

  let end = lines.length;
  const historyLines: string[] = [];
  while (end > headingIdx + 1 && historyLines.length < 3 && HISTORY_LINE.test(lines[end - 1])) {
    historyLines.unshift(lines[end - 1]);
    end--;
  }
  const bodyLines = lines.slice(headingIdx + 1, end);
  const history = historyLines.length ? historyLines.join(' ') : null;
  return {
    citation, heading, hierarchy,
    text: bodyLines.join('\n'),
    history,
    amendments: history ? parseAmendments(history) : [],
  };
}

function bodyOfCitation(citation: string): Body | null {
  const code = citation.split(/\s+/)[0]?.toUpperCase();
  return BODIES[code] ?? null;
}

async function fetchSection(docId: string): Promise<{ section: Section; url: string } | { error: 'not_found' | 'empty'; url: string }> {
  const url = `${ORIGIN}/Legis/Law.aspx?d=${docId}`;
  const res = await pwFetch(url);
  if (res.status === 404) return { error: 'not_found', url };
  if (!res.ok) throw new Error(`${UPSTREAM} returned HTTP ${res.status} for document ${docId}`);
  const html = await readStatuteResponse(res);
  const section = parseSectionPage(html);
  if (!section || (section.text.length < 20 && !section.history)) return { error: 'empty', url };
  return { section, url };
}

/* ------------------------------------------------------------------ */
/* Search list                                                         */
/* ------------------------------------------------------------------ */

interface SearchRow { doc_id: string; citation: string; body: string | null; body_name: string | null; heading: string; last_modified: string | null; url: string }

function parseSearchList(html: string): { total: number | null; rows: SearchRow[] } {
  const totalM = /There are ([\d,]+) sections? of law in this list/i.exec(html);
  const total = totalM ? Number(totalM[1].replace(/,/g, '')) : null;
  const rows: SearchRow[] = [];
  const re = /<a href="law\.aspx\?d=(\d+)" target="_blank">([^<]*)<\/a>\s*<\/td>\s*<td>\s*<a href="law\.aspx\?d=\1" target="_blank">([\s\S]*?)<\/a>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const citation = statuteText(m[2]).trim();
    const body = bodyOfCitation(citation);
    rows.push({
      doc_id: m[1], citation,
      body: body?.code ?? null, body_name: body?.name ?? null,
      heading: statuteText(m[3]).replace(/\s+/g, ' ').trim(),
      last_modified: null,
      url: `${ORIGIN}/Legis/Law.aspx?d=${m[1]}`,
    });
  }
  const mods = [...html.matchAll(/Last Modified\s+(\d{2}\/\d{2}\/\d{4})/g)].map((m) => m[1]);
  if (mods.length === rows.length) {
    rows.forEach((r, i) => {
      const [mm, dd, yyyy] = mods[i].split('/');
      r.last_modified = `${yyyy}-${mm}-${dd}`;
    });
  }
  return { total, rows };
}

function normaliseBodies(arg: unknown): { codes: string[] } | { error: string } {
  if (arg == null || arg === '' || arg === 'all' || (Array.isArray(arg) && arg.length === 0)) return { codes: SEARCH_BODY_CODES };
  const list = Array.isArray(arg) ? arg : String(arg).split(/[,\s]+/);
  const codes: string[] = [];
  for (const raw of list) {
    const key = String(raw).toLowerCase().replace(/[^a-z]/g, '');
    const code = key === 'all' ? null : (PREFIX_TO_BODY[key] ?? (BODIES[String(raw).toUpperCase()] ? String(raw).toUpperCase() : undefined));
    if (key === 'all') return { codes: SEARCH_BODY_CODES };
    if (!code) return { error: `"${raw}" is not a Louisiana law body code. Use one or more of: ${SEARCH_BODY_CODES.join(', ')}.` };
    if (!codes.includes(code)) codes.push(code);
  }
  return { codes };
}

/* ------------------------------------------------------------------ */
/* Title table of contents                                             */
/* ------------------------------------------------------------------ */

interface TocState { fields: Record<string, string>; titles: Map<string, { ctrl: string; name: string }>; at: number }
let tocCache: TocState | null = null;

async function tocForm(force = false): Promise<TocState> {
  if (tocCache && !force && Date.now() - tocCache.at < FORM_TTL_MS) return tocCache;
  const res = await pwFetch(TOC_URL);
  if (!res.ok) throw new Error(`${UPSTREAM} returned HTTP ${res.status} for the Revised Statutes table of contents`);
  const html = await readStatuteResponse(res);
  const fields = hiddenFields(html);
  const titles = new Map<string, { ctrl: string; name: string }>();
  const re = /ListViewTOC1\$(ctrl\d+)\$LinkButton1a[^>]*>\s*TITLE\s+(\d+[A-Z]?)\s*<[\s\S]*?ListViewTOC1\$\1\$LinkButton1b[^>]*>([^<]*)</g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    titles.set(m[2].toUpperCase(), { ctrl: m[1], name: statuteText(m[3]).trim() });
  }
  if (!titles.size || !fields.__VIEWSTATE) throw new Error(`${UPSTREAM} table of contents had no title list — page shape changed`);
  tocCache = { fields, titles, at: Date.now() };
  return tocCache;
}

interface TocRow { citation: string; section: string; heading: string; doc_id: string; url: string; repealed: boolean }

function parseTocRows(html: string, title: string): { titleHeading: string | null; rows: TocRow[] } {
  const rows: TocRow[] = [];
  let titleHeading: string | null = null;
  const re = /<a[^>]*href="Law\.aspx\?d=(\d+)" target="_blank">([^<]*)<\/a>\s*<\/td>\s*<td[^>]*>\s*<a[^>]*href="Law\.aspx\?d=\1" target="_blank">([\s\S]*?)<\/a>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const citation = statuteText(m[2]).trim();
    const heading = statuteText(m[3]).replace(/\s+/g, ' ').trim();
    const sec = new RegExp(`^RS\\s+${title}:(\\S+)$`, 'i').exec(citation);
    if (!sec) {
      if (new RegExp(`^RS\\s+${title}$`, 'i').test(citation)) titleHeading = heading;
      continue;
    }
    rows.push({
      citation, section: sec[1], heading, doc_id: m[1],
      url: `${ORIGIN}/Legis/Law.aspx?d=${m[1]}`,
      repealed: /^repealed\b/i.test(heading),
    });
  }
  return { titleHeading, rows };
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const tools: McpToolExport['tools'] = [
  {
    name: 'louisiana_statute',
    description:
      'Get the FULL TEXT of one section of Louisiana law by citation — Louisiana Revised Statutes ("RS 14:20" justifiable homicide, "La. R.S. 32:414" driver licence suspension), Civil Code articles ("CC 2315" liability for damages), Code of Civil Procedure ("CCP 966" summary judgment), Code of Criminal Procedure ("CCRP 701" speedy trial), Code of Evidence ("CE 404"), Children\'s Code ("CHC 603") and the Louisiana Constitution ("Const. Art. I, §5"). Returns the heading, statutory text, the section\'s enactment and amendment history ("Added by Acts 1976, No. 655; Amended by Acts 2014, No. 163") parsed into year/act pairs, and the legislature\'s own URL. Keyless; sourced live from the Louisiana State Legislature. Use for "what does Louisiana R.S. 14:20 say", "text of La. Civil Code art. 2315", or to check a Louisiana statute a case or contract cites.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        citation: { type: 'string', description: 'The citation as written: "RS 14:20", "La. R.S. 9:2800.1", "14:20" (Revised Statutes), "CC 2315" / "La. C.C. art. 2315" (Civil Code), "CCP 966", "CCRP 701", "CE 404", "CHC 603", "Const. Art. I, §5" or "CONST 1:5".' },
        doc_id: { type: 'string', description: 'Alternative to citation: the legis.la.gov document id (the d= number) returned by louisiana_law_search or louisiana_title_contents.' },
      },
    },
  },
  {
    name: 'louisiana_law_search',
    description:
      'Full-text search of Louisiana law BY TOPIC or keyword — "vehicular homicide", "security deposit lessor", "concealed handgun permit", "wrongful death damages" — across the Revised Statutes, Civil Code, Code of Civil Procedure, Code of Criminal Procedure, Code of Evidence, Children\'s Code and the Louisiana Constitution, optionally narrowed to chosen code bodies. Returns relevance-ranked sections with citation, heading, the date each was last modified, the total match count, and the doc_id to pass to louisiana_statute for full text. The engine ANDs every word, so two or three specific words outperform a sentence. Keyless; sourced live from the Louisiana State Legislature.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Topic or keywords, e.g. "vehicular homicide". Words are ANDed; "a or b" and "a not b" are understood; ""exact phrase"" in doubled quotes matches in order.' },
        bodies: { type: 'array', items: { type: 'string' }, description: 'Law bodies to search: RS (Revised Statutes), CC (Civil Code), CCP, CCRP, CE, CHC (Children\'s Code), CONST, CA, HRULE, SRULE, JRULE. Default: all.' },
        limit: { type: 'number', description: 'Max results to return, default 20, max 100 (the source renders the first 100 of a larger set).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'louisiana_title_contents',
    description:
      'List every section in one TITLE of the Louisiana Revised Statutes with its heading and doc_id — Title 14 Criminal Law, Title 32 Motor Vehicles, Title 47 Revenue and Taxation, Title 9 Civil Code Ancillaries — optionally filtered by a word in the heading, so an agent can find the right section when a keyword search is too broad ("every section of Title 14 with \'homicide\' in its heading"). Repealed sections are flagged. Keyless; sourced live from the Louisiana State Legislature\'s table of contents.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Revised Statutes title number, e.g. "14" (Criminal Law), "32" (Motor Vehicles), "47" (Revenue and Taxation).' },
        filter: { type: 'string', description: 'Optional case-insensitive substring to match in the section heading or citation, e.g. "homicide".' },
        offset: { type: 'number', description: 'Skip this many matching sections, default 0 — for paging through a large title.' },
        limit: { type: 'number', description: 'Max sections to return, default 50, max 200.' },
      },
      required: ['title'],
    },
  },
];

const SOURCE_NOTE = 'Louisiana State Legislature (legis.la.gov), live fetch, keyless';
const ATTRIBUTION = 'Louisiana statutes are public record; the legislature notes its site text is maintained for drafting purposes and is not the official publication.';
const HISTORICAL_NOTE = {
  available: false,
  note: 'legis.la.gov serves the current compiled text only; a prior point-in-time version of a section is not available from this source. The amendment history (which Acts changed it, and when) is in `history` / `amendments`.',
};

async function louisianaStatute(args: Record<string, unknown>) {
  const now = new Date().toISOString();
  let docId = args.doc_id != null ? String(args.doc_id).trim().replace(/^d=/i, '') : '';
  let parsed: ParsedCitation | null = null;
  let currentThrough: string | null = formCache.get('RS')?.currentThrough ?? null;

  if (!docId) {
    const raw = String(args.citation ?? '').trim();
    if (!raw) {
      return { found: false, reason: 'missing_argument',
        message: 'louisiana_statute needs a citation (e.g. "RS 14:20", "CC 2315") or a doc_id from louisiana_law_search.' };
    }
    parsed = parseCitation(raw);
    if (!parsed) {
      return { found: false, reason: 'unparsed_citation', citation: raw,
        message: `"${raw}" is not a Louisiana citation this tool recognises.`,
        hint: 'Revised Statutes are title:section ("RS 14:20", "9:2800.1"); code articles are a body plus article number ("CC 2315", "CCP 966", "CCRP 701", "CE 404", "CHC 603"); the Constitution is "Const. Art. I, §5" or "CONST 1:5".' };
    }
    if (!parsed.body.lookup) {
      return { found: false, reason: 'body_not_lookupable', citation: parsed.display,
        message: `${parsed.body.name} cannot be fetched by citation through this source.`,
        hint: 'Use louisiana_law_search with bodies set to that body and pass a result\'s doc_id back to louisiana_statute.' };
    }
    const r = await resolveDocId(parsed);
    currentThrough = r.currentThrough ?? currentThrough;
    if (!r.docId) {
      return { found: false, reason: 'section_not_found', citation: parsed.display, body: parsed.body.code, body_name: parsed.body.name,
        message: `The Louisiana State Legislature's site has no ${parsed.body.name} entry for ${parsed.display}.`,
        hint: 'Section numbers are not contiguous — repealed and reserved numbers are normal. louisiana_title_contents lists what exists in a Revised Statutes title; louisiana_law_search finds sections by topic.',
        laws_current_through: currentThrough, data_as_of: now };
    }
    docId = r.docId;
  }
  if (!/^\d+$/.test(docId)) {
    return { found: false, reason: 'bad_doc_id', doc_id: docId, message: 'doc_id must be the numeric d= value from a legis.la.gov Law.aspx link.' };
  }

  const got = await fetchSection(docId);
  if ('error' in got) {
    return { found: false, reason: got.error === 'not_found' ? 'document_not_found' : 'empty_document', doc_id: docId, url: got.url,
      message: got.error === 'not_found'
        ? `legis.la.gov has no document ${docId}.`
        : `Document ${docId} resolved but carried no statutory text — it may be a repealed or reserved section.`,
      data_as_of: now };
  }
  const s = got.section;
  const body = bodyOfCitation(s.citation) ?? parsed?.body ?? null;
  return {
    found: true,
    citation: s.citation,
    body: body?.code ?? null,
    body_name: body?.name ?? null,
    heading: s.heading,
    hierarchy: s.hierarchy,
    text: s.text,
    text_chars: s.text.length,
    history: s.history,
    amendments: s.amendments,
    last_amended_year: s.amendments.length ? Math.max(...s.amendments.map((a) => a.year)) : null,
    historical_version: HISTORICAL_NOTE,
    doc_id: docId,
    url: got.url,
    laws_current_through: currentThrough,
    source: SOURCE_NOTE,
    attribution: ATTRIBUTION,
    data_as_of: now,
  };
}

async function louisianaLawSearch(args: Record<string, unknown>) {
  const now = new Date().toISOString();
  const q = String(args.query ?? '').trim();
  if (!q) {
    return { found: false, reason: 'empty_query',
      message: 'louisiana_law_search needs a query — search by topic, e.g. "vehicular homicide".',
      hint: 'To look up a known citation use louisiana_statute instead.' };
  }
  const bodies = normaliseBodies(args.bodies);
  if ('error' in bodies) return { found: false, reason: 'bad_body', message: bodies.error };
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));

  let parsedList: { total: number | null; rows: SearchRow[] } | null = null;
  let currentThrough: string | null = null;
  for (const attempt of [0, 1]) {
    const form = await formFor('RS', attempt === 1);
    currentThrough = form.currentThrough;
    const fields: Record<string, string> = {
      ...form.fields,
      __EVENTTARGET: '',
      __EVENTARGUMENT: '',
      [`${P}ddlLawBodies`]: 'RS',
      [`${P}tbFirstNumber`]: ' Title',
      [`${P}tbSecondNumber`]: ' Section',
      [`${P}tbText`]: q,
      [`${P}btnSearchText`]: 'Search',
    };
    for (const code of bodies.codes) fields[`${P}cbLaws$${BODIES[code].box}`] = 'on';
    const res = await postForm(SEARCH_LIST_URL, fields);
    if (res.status >= 300 && res.status < 400) {
      // A single-hit search 302s straight to the section; a rejected one
      // 302s back to the blank form.
      const docId = docIdFromRedirect(res);
      await res.arrayBuffer().catch(() => undefined);
      if (docId) {
        const got = await fetchSection(docId);
        if ('error' in got) { parsedList = { total: 0, rows: [] }; break; }
        const body = bodyOfCitation(got.section.citation);
        parsedList = { total: 1, rows: [{ doc_id: docId, citation: got.section.citation, body: body?.code ?? null, body_name: body?.name ?? null,
          heading: got.section.heading ?? '', last_modified: null, url: got.url }] };
        break;
      }
      if (attempt === 0) continue;
      return { found: false, reason: 'search_rejected', query: q, bodies: bodies.codes,
        message: `The Louisiana State Legislature's search engine sent "${q}" back to the form without a result list. It does that silently for queries that match too many sections.`,
        hint: 'Add a second, more specific word — "tax" alone is refused, "sales tax exemption" is answered.',
        laws_current_through: currentThrough, data_as_of: now };
    }
    if (!res.ok) throw new Error(`${UPSTREAM} returned HTTP ${res.status} for the search list`);
    const html = await readStatuteResponse(res);
    if (!/sections? of law in this list/i.test(html)) {
      // Rendered the search form instead of a list: viewstate aged out or
      // the query was refused. Refresh once, then report.
      if (attempt === 0) continue;
      return { found: false, reason: 'search_rejected', query: q, bodies: bodies.codes,
        message: `The Louisiana State Legislature's search engine sent "${q}" back to the form without a result list. It does that silently for queries that match too many sections.`,
        hint: 'Add a second, more specific word — "tax" alone is refused, "sales tax exemption" is answered.',
        laws_current_through: currentThrough, data_as_of: now };
    }
    parsedList = parseSearchList(html);
    break;
  }
  const list = parsedList ?? { total: 0, rows: [] };
  if (!list.rows.length) {
    return { found: false, reason: 'no_match', query: q, bodies: bodies.codes, total: list.total ?? 0,
      message: `No section of Louisiana law matched "${q}" in ${bodies.codes.join(', ')}.`,
      hint: 'Every word must appear — try fewer words, Louisiana\'s own terms (lessor/lessee rather than landlord/tenant, parish rather than county), or "a or b" for synonyms.',
      laws_current_through: currentThrough, data_as_of: now };
  }
  const results = list.rows.slice(0, limit);
  return {
    found: true,
    query: q,
    bodies: bodies.codes,
    total: list.total ?? list.rows.length,
    count: results.length,
    truncated_at_source: (list.total ?? 0) > list.rows.length,
    results,
    hint: 'Pass a result\'s doc_id (or its citation) to louisiana_statute for the full text and amendment history.',
    laws_current_through: currentThrough,
    source: SOURCE_NOTE,
    attribution: ATTRIBUTION,
    data_as_of: now,
  };
}

async function louisianaTitleContents(args: Record<string, unknown>) {
  const now = new Date().toISOString();
  const title = String(args.title ?? '').trim().replace(/^(?:title|rs|la\.?\s*r\.?s\.?)\s*/i, '').replace(/:.*$/, '').toUpperCase();
  if (!/^\d+[A-Z]?$/.test(title)) {
    return { found: false, reason: 'bad_title', title: args.title ?? null,
      message: 'title must be a Revised Statutes title number, e.g. "14" or "47".' };
  }
  const filter = String(args.filter ?? '').trim().toLowerCase();
  const offset = Math.max(0, Number(args.offset) || 0);
  const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));

  let parsedRows: { titleHeading: string | null; rows: TocRow[] } | null = null;
  let titleName: string | null = null;
  for (const attempt of [0, 1]) {
    const toc = await tocForm(attempt === 1);
    const entry = toc.titles.get(title);
    if (!entry) {
      const known = [...toc.titles.keys()].join(', ');
      return { found: false, reason: 'title_not_found', title,
        message: `The Louisiana Revised Statutes have no Title ${title}.`,
        hint: `Titles currently in force: ${known}.`, data_as_of: now };
    }
    titleName = entry.name;
    const res = await postForm(TOC_URL, {
      ...toc.fields,
      __EVENTTARGET: `${P}ListViewTOC1$${entry.ctrl}$LinkButton1a`,
      __EVENTARGUMENT: '',
    });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      if (attempt === 0) continue;
      throw new Error(`${UPSTREAM} returned HTTP ${res.status} for the Title ${title} contents`);
    }
    const html = await readStatuteResponse(res);
    parsedRows = parseTocRows(html, title);
    if (parsedRows.rows.length || attempt === 1) break;
  }
  const all = parsedRows?.rows ?? [];
  if (!all.length) {
    return { found: false, reason: 'empty_title', title, title_name: titleName,
      message: `The table of contents for Title ${title} came back with no sections — the page shape may have changed.`,
      data_as_of: now };
  }
  const matched = filter ? all.filter((r) => r.heading.toLowerCase().includes(filter) || r.citation.toLowerCase().includes(filter)) : all;
  const page = matched.slice(offset, offset + limit);
  return {
    found: page.length > 0,
    title,
    title_name: titleName,
    title_heading: parsedRows?.titleHeading ?? null,
    filter: filter || null,
    total_sections: all.length,
    matched: matched.length,
    offset,
    count: page.length,
    next_offset: offset + page.length < matched.length ? offset + page.length : null,
    sections: page,
    ...(page.length ? {} : { message: `No section of Title ${title} matches "${filter}" in its heading.`, hint: 'Headings are short — try a shorter word, or louisiana_law_search for full-text matching.' }),
    hint: 'Pass a section\'s doc_id or citation to louisiana_statute for its full text.',
    laws_current_through: formCache.get('RS')?.currentThrough ?? null,
    source: `${SOURCE_NOTE} — Revised Statutes table of contents`,
    attribution: ATTRIBUTION,
    data_as_of: now,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'louisiana_statute':
      return louisianaStatute(args);
    case 'louisiana_law_search':
      return louisianaLawSearch(args);
    case 'louisiana_title_contents':
      return louisianaTitleContents(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
