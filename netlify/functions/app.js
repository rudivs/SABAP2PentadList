console.log('Loading app');
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const serverless = require('serverless-http');
const app = express();
const bodyParser = require('body-parser');
const router = express.Router();
const XENO_CANTO_API_URL = 'https://xeno-canto.org/api/3/recordings';
const XENO_CANTO_API_KEY = process.env.XENO_CANTO_API_KEY || process.env.XC_API_KEY;
const MAIN_PENTAD_TIMEOUT_MS = 10000;
const ADJACENT_PENTAD_TIMEOUT_MS = 8000;

function quoteQueryValue(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildScientificNameQuery(speciesName, quality, country) {
  const filters = [`grp:birds`, `sp:${quoteQueryValue(speciesName)}`];
  if (quality) {
    filters.push(`q:${quality}`);
  }
  if (country) {
    filters.push(`cnt:${quoteQueryValue(country)}`);
  }
  return filters.join(' ');
}

function buildCommonNameQuery(commonName, country) {
  const filters = [`grp:birds`, `en:${quoteQueryValue(`=${commonName}`)}`];
  if (country) {
    filters.push(`cnt:${quoteQueryValue(country)}`);
  }
  return filters.join(' ');
}

async function fetchCalls(query) {
  if (!XENO_CANTO_API_KEY) {
    const error = new Error('Missing XENO_CANTO_API_KEY or XC_API_KEY');
    error.code = 'MISSING_XENO_CANTO_API_KEY';
    throw error;
  }

  const apiUrl = new URL(XENO_CANTO_API_URL);
  apiUrl.searchParams.set('query', query);
  apiUrl.searchParams.set('key', XENO_CANTO_API_KEY);
  const logUrl = new URL(XENO_CANTO_API_URL);
  logUrl.searchParams.set('query', query);
  logUrl.searchParams.set('key', '[redacted]');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  console.log(`Fetching '${logUrl.toString()}'...`);

  try {
    const response = await fetch(apiUrl, { signal: controller.signal });
    const data = await response.json();

    if (!response.ok || data?.error) {
      const error = new Error(data?.message || `xeno-canto request failed with status ${response.status}`);
      error.code = 'XENO_CANTO_API_ERROR';
      throw error;
    }

    if (!Array.isArray(data?.recordings)) {
      const error = new Error('Unexpected xeno-canto response shape');
      error.code = 'XENO_CANTO_INVALID_RESPONSE';
      throw error;
    }

    return data.recordings;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchPentadSpecies(pentadCode, timeoutMs) {
  const apiUrl = `http://api.adu.org.za/sabap2/v2/coverage/pentad/${pentadCode}?format=JSON`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    console.log(`Fetching ${pentadCode} from ${apiUrl}...`);
    const response = await fetch(apiUrl, { signal: controller.signal });

    if (!response.ok) {
      const error = new Error(`SABAP2 request failed with status ${response.status}`);
      error.code = 'SABAP2_API_ERROR';
      throw error;
    }

    const data = await response.json();
    return data?.data?.species || [];
  } finally {
    clearTimeout(timeoutId);
  }
}

router.get('/results', async (req, res) => {
  console.log('Fetching bird list...');
  const pentadCode = req.query.pentadCode;
  let species;
  try {
    species = await fetchPentadSpecies(pentadCode, MAIN_PENTAD_TIMEOUT_MS);
  }
  catch (error) {
    console.error(`Fetching ${pentadCode} failed:`, error);
    if (error.name === 'AbortError') {
      res.status(504).send('Fetching bird list timed out');
      return;
    }
    res.status(500).send('Fetching bird list failed');
    return;
  }
  const [x, y] = pentadCode.split('_').map(str => parseInt(str));
  const pentads = [
    `${x - 5}_${y - 5}`,
    `${x}_${y - 5}`,
    `${x + 5}_${y - 5}`,
    `${x - 5}_${y}`,
    `${x + 5}_${y}`,
    `${x - 5}_${y + 5}`,
    `${x}_${y + 5}`,
    `${x + 5}_${y + 5}`
    ];
    const speciesLists = await Promise.all(pentads.map(async pentad => { 
      try {
        const adjacentSpecies = await fetchPentadSpecies(pentad, ADJACENT_PENTAD_TIMEOUT_MS);
        if (!adjacentSpecies.length) {
          console.log(`Pentad ${pentad} returned no species`);
          return [];
        }
        console.log(`Pentad ${pentad} returned ${adjacentSpecies.length} species...`);
        return adjacentSpecies;
      } catch (error) {
        if (error.name === 'AbortError') {
          console.error(`Fetching ${pentad} timed out`);
        } else {
          console.error(`Fetching ${pentad} failed:`, error);
        }
        return [];
      }
    }));
  let speciesAdjacentPentads = [].concat(...speciesLists);
    if (species && species.length > 0) {
    speciesAdjacentPentads = speciesAdjacentPentads.filter(speciesAdjacent => {
      return !species.some(species => species.Ref === speciesAdjacent?.Ref);
    });
  }
  const speciesAdjacent = speciesAdjacentPentads.reduce((counts, species) => {
    if (!counts[species?.Ref]) {
      counts[species.Ref] = {
        Ref: species.Ref,
        Common_group: species.Common_group,
        Common_species: species.Common_species,
        Genus: species.Genus,
        Species: species.Species,
        Pentads: 1
      };
    } else {
      counts[species.Ref].Pentads += 1;
    }
    return counts;
  }, {});
  const speciesAdjacentArray = Object.values(speciesAdjacent).sort((a, b) => b.Pentads - a.Pentads);
  
  let sortKey = 'fp';
  let sortOrder = 1;
  if (req.query.sortKey) {
    sortKey = req.query.sortKey;
  }
  if (req.query.sortOrder) {
    sortOrder = parseInt(req.query.sortOrder);
  }
  species = species.sort((a,b) => sortOrder * (b[sortKey] - a[sortKey]));
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.write(`
  <html>
    <head>
      <title>Pentad ${pentadCode}</title>
    </head>
    <body>
      <div class="results-section">
        <h1>Pentad ${pentadCode} Species List</h1>
        <div class="results-table">
          <table id="species-table" class="display compact">
          <thead>
            <tr>
              <th>Species</th>
              <th>Group</th>
              <th>FP Rate</th>
              <th>Call</th>
            </tr>
          </thead>
          <tbody>
            ${species.map(species =>`
              <tr>
                <td>${species.Common_species}</td>
                <td>${species.Common_group || ''}</td>
                <td>${parseFloat(species.fp).toFixed(1)}</td>
                <td><a href="#" onclick="playCall('${species.Genus} ${species.Species}', '${species.Common_species} ${species.Common_group}')">Listen</a></td>
              </tr>
            `).join('')}
          </tbody>
          </table>
        </div>
      </div>
      <div class="results-section">
        <h2>Possible Species</h2>
        <div class="results-table">
          <table id="possible-species" class="display compact">
          <thead>
            <tr>
              <th>Group</th>
              <th>Species</th>
              <th>Pentads</th>
              <th>Call</th>
            </tr>
          </thead>
          <tbody>
            ${speciesAdjacentArray
              .map(species => {
                return `
                  <tr>
                    <td>${species.Common_group || ''}</td>
                    <td>${species.Common_species}</td>
                    <td>${species.Pentads}</td>
                    <td><a href="#" onclick="playCall('${species.Genus} ${species.Species}', '${species.Common_species} ${species.Common_group}')">Listen</a></td>
                  </tr>
                `;
              }).join('')}
          </tbody>
          </table>
        </div>
      </div>
    </body>
  </html>
`);

  res.end();
  });

  router.get('/call', async (req, res) => {
    console.log('Fetching bird call...');
    const speciesName = req.query.speciesName;
    const commonName = req.query.commonName;
    const country = req.query.cnt;
    const queries = [
      buildScientificNameQuery(speciesName, 'A', country || 'South Africa'),
      buildScientificNameQuery(speciesName, 'A', null),
      buildCommonNameQuery(commonName, country || 'South Africa'),
      buildCommonNameQuery(commonName, null)
    ];

    try {
      let recordings = [];

      for (const query of queries) {
        recordings = await fetchCalls(query);
        if (recordings.length) {
          break;
        }
      }

      if (!recordings.length) {
        res.status(404).json({ error: 'No matching recordings found' });
        return;
      }

      let randomIndex = Math.floor(Math.random() * recordings.length);
      let result = {};
      result.file = recordings[randomIndex].file;
      result.country = recordings[randomIndex].cnt;
      result.location = recordings[randomIndex].loc;
      result.type = recordings[randomIndex].type;
      console.log(result.file);
      res.json(result);
    } catch (error) {
      console.error('Fetching bird call failed:', error);

      if (error.code === 'MISSING_XENO_CANTO_API_KEY') {
        res.status(503).json({
          error: 'Xeno-canto API key is not configured. Set XENO_CANTO_API_KEY or XC_API_KEY.'
        });
        return;
      }

      if (error.name === 'AbortError') {
        res.status(504).json({ error: 'Timed out while fetching audio from xeno-canto' });
        return;
      }

      res.status(502).json({
        error: error.message || 'Fetching bird call failed'
      });
    }
    });

  app.use(bodyParser.json());
  app.use('/.netlify/functions/app', router);  // path must route to lambda
  app.use('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  
  module.exports = app;
  module.exports.handler = serverless(app);;
