import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getValidToken, refreshAccessToken } from './auth.js';
import { toArxivUrl } from './papers.js';

const ALPHAXIV_MCP_URL = 'https://api.alphaxiv.org/mcp/v1';
const execFileAsync = promisify(execFile);

let _client = null;
let _connected = false;
let _lastTransportLog = { message: '', time: 0 };
const _searchCache = new Map();

function getErrorMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function isTransientTransportError(err) {
  const message = getErrorMessage(err);
  return (
    message.includes('SSE stream disconnected') ||
    message.includes('Failed to open SSE stream') ||
    message.includes('Failed to reconnect SSE stream') ||
    message.includes('Maximum reconnection attempts') ||
    message.includes('Bad Gateway') ||
    message.includes('TypeError: terminated') ||
    message.includes('terminated')
  );
}

function logTransportError(err) {
  const message = getErrorMessage(err);

  if (isTransientTransportError(message)) {
    const now = Date.now();
    if (_lastTransportLog.message === message && now - _lastTransportLog.time < 10000) {
      return;
    }
    _lastTransportLog = { message, time: now };
    process.stderr.write(`[alpha] alphaXiv MCP transient transport issue: ${message}\n`);
    return;
  }

  process.stderr.write(`[alpha] alphaXiv MCP error: ${message}\n`);
}

async function getClient() {
  if (_client && _connected) return _client;

  const token = await getValidToken();
  if (!token) {
    throw new Error('Not logged in. Run `alpha login` first.');
  }

  _client = new Client({ name: 'alpha', version: '0.1.0' });

  _client.onerror = (err) => {
    if (isTransientTransportError(err)) {
      _connected = false;
    }
    logTransportError(err);
  };

  const transport = new StreamableHTTPClientTransport(new URL(ALPHAXIV_MCP_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  await _client.connect(transport);
  _connected = true;

  return _client;
}

async function callTool(name, args) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    let client;
    try {
      client = await getClient();
    } catch (err) {
      if (err.message?.includes('401') || err.message?.includes('Unauthorized')) {
        const newToken = await refreshAccessToken();
        if (newToken) {
          _client = null;
          _connected = false;
          client = await getClient();
        } else {
          throw new Error('Session expired. Run `alpha login` to re-authenticate.');
        }
      } else {
        throw err;
      }
    }

    try {
      const result = await client.callTool({ name, arguments: args });

      if (result.isError) {
        const text = result.content?.[0]?.text || 'Unknown error';
        throw new Error(text);
      }

      const text = result.content?.[0]?.text;
      if (!text) return result.content;

      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (err) {
      lastError = err;
      if (!isTransientTransportError(err) || attempt === 2) {
        throw err;
      }
      await disconnect();
    }
  }

  throw lastError ?? new Error('alphaXiv MCP call failed');
}

export async function searchByEmbedding(query) {
  return await searchArxiv(query);
}

export async function searchByKeyword(query) {
  return await searchArxiv(query);
}

export async function agenticSearch(query) {
  return await searchArxiv(query);
}

export async function searchAll(query) {
  const [semantic, keyword, agentic] = await Promise.all([
    searchByEmbedding(query),
    searchByKeyword(query),
    agenticSearch(query),
  ]);

  return { semantic, keyword, agentic };
}

export async function getPaperContent(url, { fullText = false } = {}) {
  const args = { url };
  if (fullText) args.fullText = true;
  return await callTool('get_paper_content', args);
}

export async function answerPdfQuery(url, query) {
  try {
    return await callTool('answer_pdf_queries', { url: toArxivUrl(url), queries: [query] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Input validation error') || message.includes('Invalid arguments')) {
      return await callTool('answer_pdf_queries', { url: toArxivUrl(url), queries: [query] });
    }
    throw err;
  }
}

export async function readGithubRepo(githubUrl, path = '/') {
  return await callTool('read_files_from_github_repository', { githubUrl, path });
}

export async function disconnect() {
  if (_client) {
    _client.onerror = () => {};
    try {
      await _client.close();
    } catch {
    }
    _client = null;
    _connected = false;
  }
}

async function searchArxiv(query) {
  const cacheKey = query.trim();
  if (!_searchCache.has(cacheKey)) {
    const promise = searchArxivUncached(query).catch((err) => {
      _searchCache.delete(cacheKey);
      throw err;
    });
    _searchCache.set(cacheKey, promise);
  }
  return await _searchCache.get(cacheKey);
}

async function searchArxivUncached(query) {
  const htmlParams = new URLSearchParams({
    query,
    searchtype: 'all',
    abstracts: 'show',
    size: '25',
  });
  const htmlUrl = `https://arxiv.org/search/?${htmlParams.toString()}`;
  const html = await fetchTextWithCurl(htmlUrl).catch(async () => {
    const htmlResponse = await fetch(htmlUrl, { signal: AbortSignal.timeout(30000) });
    if (!htmlResponse.ok) return null;
    return await htmlResponse.text();
  });
  if (html) {
    const results = parseArxivHtml(html);
    if (results) return results;
  }

  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: '0',
    max_results: '10',
    sortBy: 'relevance',
    sortOrder: 'descending',
  });
  const response = await fetchArxivWithRetry(`https://export.arxiv.org/api/query?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`arXiv search failed: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => match[1]);
  if (!entries.length) return 'No papers found for the given query.';

  return entries.map(formatArxivEntry).join('\n\n');
}

function formatArxivEntry(entry, index) {
  const idUrl = xmlText(entry, 'id');
  const arxivId = (idUrl.match(/\/abs\/([^/]+)$/)?.[1] ?? idUrl).replace(/v\d+$/, '');
  const title = normalizeWhitespace(xmlText(entry, 'title'));
  const summary = normalizeWhitespace(xmlText(entry, 'summary'));
  const publishedAt = xmlText(entry, 'published').slice(0, 10);
  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g)]
    .map((match) => decodeXml(match[1]))
    .join(', ');

  return [
    `${index + 1}. **${title}** (Published on ${publishedAt}, 0 Visits, 0 Likes)`,
    `- arXiv Id: ${arxivId}`,
    `- Authors: ${authors}`,
    `- Abstract: ${summary}`,
  ].join('\n');
}

function xmlText(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? decodeXml(match[1]) : '';
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '...')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .trim();
}

async function fetchArxivWithRetry(url) {
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'alpha-hub/0.1.3',
      },
    });
    if (response.status !== 429) return response;

    const retryAfter = Number(response.headers.get('retry-after'));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 5000)
      : (attempt + 1) * 3000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return response;
}

function parseArxivHtml(html) {
  const entries = [...html.matchAll(/<li class="arxiv-result">([\s\S]*?)<\/li>/g)]
    .map((match) => match[1])
    .slice(0, 10);
  if (!entries.length) return null;

  return entries.map(formatArxivHtmlEntry).join('\n\n');
}

function formatArxivHtmlEntry(entry, index) {
  const arxivId = stripHtml(entry.match(/<p class="list-title[\s\S]*?arxiv\.org\/abs\/([^"]+)/)?.[1] ?? '');
  const title = stripHtml(entry.match(/<p class="title[\s\S]*?>([\s\S]*?)<\/p>/)?.[1] ?? '');
  const authors = stripHtml(entry.match(/<p class="authors">([\s\S]*?)<\/p>/)?.[1] ?? '')
    .replace(/^Authors:\s*/i, '');
  const abstract = stripHtml(
    entry.match(/<span class="abstract-full[\s\S]*?>([\s\S]*?)<a class="is-size-7"/)?.[1] ??
    entry.match(/<span class="abstract-short[\s\S]*?>([\s\S]*?)<a class="is-size-7"/)?.[1] ??
    ''
  ).replace(/^Abstract:\s*/i, '');
  const submitted = stripHtml(entry.match(/<span[^>]*>\s*Submitted\s*<\/span>\s*([^;]+);/)?.[1] ?? '');

  return [
    `${index + 1}. **${title}** (Published on ${submitted || 'unknown'}, 0 Visits, 0 Likes)`,
    `- arXiv Id: ${arxivId.replace(/v\d+$/, '')}`,
    `- Authors: ${authors}`,
    `- Abstract: ${abstract}`,
  ].join('\n');
}

function stripHtml(value) {
  return normalizeWhitespace(decodeXml(value.replace(/<[^>]+>/g, ' ')));
}

async function fetchTextWithCurl(url) {
  const { stdout } = await execFileAsync('curl', [
    '--fail',
    '--silent',
    '--show-error',
    '--location',
    '--max-time',
    '30',
    url,
  ], {
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout;
}
