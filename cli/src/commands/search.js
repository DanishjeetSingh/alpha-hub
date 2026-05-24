import chalk from 'chalk';
import { searchByEmbedding, searchByKeyword, agenticSearch, disconnect } from '../lib/alphaxiv.js';
import { parsePaperSearchResults } from '../lib/index.js';
import { output, error, info } from '../lib/output.js';

function formatResults(data) {
  const text = typeof data === 'string' ? data : formatGroupedResults(data);
  console.log(text);
}

function formatGroupedResults(data) {
  if (data && typeof data === 'object') {
    return Object.entries(data)
      .map(([key, value]) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return `${key}:\n${text}`;
      })
      .join('\n\n');
  }
  return JSON.stringify(data, null, 2);
}

function describeMode(mode) {
  switch (mode) {
    case 'keyword':
      return 'keyword full-text';
    case 'agentic':
      return 'agentic';
    case 'both':
      return 'semantic + keyword';
    case 'all':
      return 'semantic + keyword + agentic';
    default:
      return 'semantic';
  }
}

function parseLimit(value) {
  if (value === undefined) return null;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('--limit must be a positive integer');
  }
  return limit;
}

function limitTextResults(text, limit) {
  if (!limit || typeof text !== 'string') return text;
  return text
    .split(/\n(?=\d+\.\s+\*\*)/g)
    .map((block) => block.trim())
    .filter(Boolean)
    .slice(0, limit)
    .join('\n\n');
}

function limitResults(results, limit) {
  if (!limit) return results;
  if (typeof results === 'string') return limitTextResults(results, limit);
  if (results && typeof results === 'object') {
    return Object.fromEntries(
      Object.entries(results).map(([key, value]) => [key, limitResults(value, limit)])
    );
  }
  return results;
}

function toJsonPayload(query, mode, results, limit) {
  if (mode === 'both' || mode === 'all') {
    return {
      query,
      mode,
      limit,
      ...Object.fromEntries(
        Object.entries(results).map(([key, value]) => [
          key,
          parsePaperSearchResults(value, { limit }),
        ])
      ),
    };
  }

  return {
    query,
    mode,
    limit,
    ...parsePaperSearchResults(results, { limit }),
  };
}

export function registerSearchCommand(program) {
  program
    .command('search <query>')
    .description('Search papers via alphaXiv (semantic, keyword, both, agentic, or all)')
    .option('-m, --mode <mode>', 'Search mode: semantic, keyword, both, agentic, all', 'semantic')
    .option('--limit <n>', 'Limit output to the top n results')
    .action(async (query, cmdOpts) => {
      const opts = { ...program.opts(), ...cmdOpts };
      try {
        const limit = parseLimit(opts.limit);
        if (!opts.json) {
          info(chalk.dim(`Searching alphaXiv (${describeMode(opts.mode)})...`));
        }
        let results;
        if (opts.mode === 'keyword') {
          results = await searchByKeyword(query);
        } else if (opts.mode === 'agentic') {
          results = await agenticSearch(query);
        } else if (opts.mode === 'both') {
          const [semantic, keyword] = await Promise.all([
            searchByEmbedding(query),
            searchByKeyword(query),
          ]);
          results = { semantic, keyword };
        } else if (opts.mode === 'all') {
          const [semantic, keyword, agentic] = await Promise.all([
            searchByEmbedding(query),
            searchByKeyword(query),
            agenticSearch(query),
          ]);
          results = { semantic, keyword, agentic };
        } else {
          results = await searchByEmbedding(query);
        }

        const limitedResults = limitResults(results, limit);
        output(
          opts.json ? toJsonPayload(query, opts.mode, limitedResults, limit) : limitedResults,
          formatResults,
          opts
        );
      } catch (err) {
        error(err.message, opts);
      } finally {
        await disconnect();
      }
    });
}
