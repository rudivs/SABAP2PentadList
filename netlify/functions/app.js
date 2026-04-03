console.log('Loading app');
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const serverless = require('serverless-http');
const app = express();
const bodyParser = require('body-parser');
const router = express.Router();
const XENO_CANTO_API_URL = 'https://xeno-canto.org/api/3/recordings';
const SABAP_PENTAD_PROXY_PATH = '/.netlify/functions/sabap-pentad';
const XENO_CANTO_API_KEY = process.env.XENO_CANTO_API_KEY || process.env.XC_API_KEY;
const MAIN_PENTAD_TIMEOUT_MS = 10000;
const ADJACENT_PENTAD_TIMEOUT_MS = 8000;
const GRID_LEVEL_UNKNOWN = null;
const GRID_SHADE_BY_LEVEL = {
  1: '#d1d5db',
  2: '#b7bdc7',
  3: '#9ca3af',
  4: '#7d8593',
  5: '#5d6471',
  6: '#374151',
  7: '#111827'
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createEmptyGridMatrix() {
  return [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
}

function setMatrixCell(matrix, rowIndex, columnIndex, state) {
  matrix[rowIndex][columnIndex] = state;
}

function getReportingLevel(speciesItem) {
  const fp = Number.parseFloat(speciesItem?.fp);
  if (Number.isFinite(fp) && fp > 0) {
    return Math.min(7, Math.max(1, Math.ceil((fp * 7) / 100)));
  }

  const ad = Number.parseFloat(speciesItem?.ad);
  if (Number.isFinite(ad) && ad > 0) {
    return 1;
  }

  return 0;
}

function getPresenceLabel(matrix, centerLevel) {
  const flatLevels = matrix.flat();
  const adjacentPresentCount = flatLevels.filter(level => typeof level === 'number' && level > 0).length - (centerLevel > 0 ? 1 : 0);
  const unknownCount = flatLevels.filter(level => level === GRID_LEVEL_UNKNOWN).length;
  const centerLabel = centerLevel > 0 ? `current pentad level ${centerLevel}` : 'current pentad absent';
  const adjacentLabel = adjacentPresentCount === 1 ? '1 adjacent pentad with sightings' : `${adjacentPresentCount} adjacent pentads with sightings`;
  const unknownLabel = unknownCount === 0 ? '' : (unknownCount === 1 ? '; 1 adjacent pentad unknown' : `; ${unknownCount} adjacent pentads unknown`);
  return `${centerLabel}; ${adjacentLabel}${unknownLabel}.`;
}

function buildPentadPresenceSvg(matrix) {
  const cellSize = 14;
  const gridSize = cellSize * 3;
  const cellInset = 1;
  const dotRadius = 3;
  let markerMarkup = '';

  matrix.forEach((row, rowIndex) => {
    row.forEach((level, columnIndex) => {
      const x = columnIndex * cellSize;
      const y = rowIndex * cellSize;

      if (typeof level === 'number' && level > 0) {
        markerMarkup += `<circle cx="${x + (cellSize / 2)}" cy="${y + (cellSize / 2)}" r="${dotRadius}" fill="${GRID_SHADE_BY_LEVEL[level] || GRID_SHADE_BY_LEVEL[1]}"></circle>`;
        return;
      }

      if (level === GRID_LEVEL_UNKNOWN) {
        markerMarkup += `<text x="${x + (cellSize / 2)}" y="${y + 10}" text-anchor="middle" font-size="10" font-family="Arial, sans-serif" fill="#4b5563">?</text>`;
      }
    });
  });

  const title = escapeHtml(getPresenceLabel(matrix, matrix[1][1]));
  return `
    <svg class="pentad-grid-svg" viewBox="0 0 ${gridSize} ${gridSize}" role="img" aria-label="${title}" xmlns="http://www.w3.org/2000/svg">
      <title>${title}</title>
      <rect x="0" y="0" width="${gridSize}" height="${gridSize}" fill="#ffffff" stroke="#111827" stroke-width="1"></rect>
      <path d="M ${cellSize} 0 V ${gridSize} M ${cellSize * 2} 0 V ${gridSize} M 0 ${cellSize} H ${gridSize} M 0 ${cellSize * 2} H ${gridSize}" stroke="#111827" stroke-width="1" fill="none"></path>
      <rect x="${cellSize + cellInset}" y="${cellSize + cellInset}" width="${cellSize - (cellInset * 2)}" height="${cellSize - (cellInset * 2)}" fill="#f8fafc"></rect>
      ${markerMarkup}
    </svg>
  `.trim();
}

function formatPentadCoordinate(value) {
  const degrees = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(degrees).padStart(2, '0')}${String(minutes).padStart(2, '0')}`;
}

function offsetPentadCoordinate(coordinate, deltaMinutes) {
  const degrees = Math.floor(coordinate / 100);
  const minutes = coordinate % 100;
  const totalMinutes = (degrees * 60) + minutes + deltaMinutes;

  return formatPentadCoordinate(totalMinutes);
}

function getAdjacentPentadPositions(x, y) {
  return [
    { pentad: `${offsetPentadCoordinate(x, -5)}_${offsetPentadCoordinate(y, -5)}`, rowIndex: 0, columnIndex: 0 },
    { pentad: `${offsetPentadCoordinate(x, -5)}_${offsetPentadCoordinate(y, 0)}`, rowIndex: 0, columnIndex: 1 },
    { pentad: `${offsetPentadCoordinate(x, -5)}_${offsetPentadCoordinate(y, 5)}`, rowIndex: 0, columnIndex: 2 },
    { pentad: `${offsetPentadCoordinate(x, 0)}_${offsetPentadCoordinate(y, -5)}`, rowIndex: 1, columnIndex: 0 },
    { pentad: `${offsetPentadCoordinate(x, 0)}_${offsetPentadCoordinate(y, 5)}`, rowIndex: 1, columnIndex: 2 },
    { pentad: `${offsetPentadCoordinate(x, 5)}_${offsetPentadCoordinate(y, -5)}`, rowIndex: 2, columnIndex: 0 },
    { pentad: `${offsetPentadCoordinate(x, 5)}_${offsetPentadCoordinate(y, 0)}`, rowIndex: 2, columnIndex: 1 },
    { pentad: `${offsetPentadCoordinate(x, 5)}_${offsetPentadCoordinate(y, 5)}`, rowIndex: 2, columnIndex: 2 }
  ];
}

function buildSpeciesGridMatrix(centerLevel, adjacentLevelsByPentad, adjacentStatuses) {
  const matrix = createEmptyGridMatrix();
  setMatrixCell(matrix, 1, 1, centerLevel);

  adjacentStatuses.forEach(({ rowIndex, columnIndex, pentad, failed }) => {
    if (failed) {
      setMatrixCell(matrix, rowIndex, columnIndex, GRID_LEVEL_UNKNOWN);
      return;
    }

    const level = adjacentLevelsByPentad.get(pentad) || 0;
    setMatrixCell(
      matrix,
      rowIndex,
      columnIndex,
      level
    );
  });

  return matrix;
}

function buildGridCell(svg) {
  return `<td class="grid-column-cell">${svg}</td>`;
}

function buildListenLink(scientificName, commonName) {
  return `
    <a
      href="#"
      class="listen-button"
      aria-label="Play call for ${escapeHtml(commonName)}"
      title="Play call for ${escapeHtml(commonName)}"
      data-scientific-name="${escapeHtml(scientificName)}"
      data-common-name="${escapeHtml(commonName)}"
      onclick="playCall(this.dataset.scientificName, this.dataset.commonName); return false;"
    >
      <svg class="listen-button-icon" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 9h4l5-4v14l-5-4H5z" fill="currentColor"></path>
        <path d="M16.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"></path>
        <path d="M18.75 6a8.25 8.25 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"></path>
      </svg>
    </a>
  `.trim();
}

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

function getRequestOrigin(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = forwardedProto ? forwardedProto.split(',')[0] : 'http';
  return `${protocol}://${req.headers.host}`;
}

async function fetchPentadSpeciesViaProxy(req, pentadCode, timeoutMs) {
  const proxyUrl = new URL(SABAP_PENTAD_PROXY_PATH, getRequestOrigin(req));
  proxyUrl.searchParams.set('code', pentadCode);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    console.log(`Fetching ${pentadCode} via ${proxyUrl.toString()}...`);
    const response = await fetch(proxyUrl, { signal: controller.signal });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(errorText || `SABAP proxy failed with status ${response.status}`);
      error.code = 'SABAP_PROXY_ERROR';
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
  let adjacentFailures = 0;
  try {
    species = await fetchPentadSpeciesViaProxy(req, pentadCode, MAIN_PENTAD_TIMEOUT_MS);
    if (species.length) {
      console.log(`Main pentad ${pentadCode} returned ${species.length} species...`);
    } else {
      console.log(`Main pentad ${pentadCode} returned no species`);
    }
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
  const adjacentPentads = getAdjacentPentadPositions(x, y);
  const speciesLists = await Promise.all(adjacentPentads.map(async ({ pentad, rowIndex, columnIndex }) => {
      try {
        const adjacentSpecies = await fetchPentadSpeciesViaProxy(req, pentad, ADJACENT_PENTAD_TIMEOUT_MS);
        if (!adjacentSpecies.length) {
          console.log(`Pentad ${pentad} returned no species`);
          return { pentad, rowIndex, columnIndex, species: [], failed: false };
        }
        console.log(`Pentad ${pentad} returned ${adjacentSpecies.length} species...`);
        return { pentad, rowIndex, columnIndex, species: adjacentSpecies, failed: false };
      } catch (error) {
        if (error.name === 'AbortError') {
          console.error(`Fetching ${pentad} timed out`);
        } else {
          console.error(`Fetching ${pentad} failed:`, error);
        }
        return { pentad, rowIndex, columnIndex, species: [], failed: true };
      }
    }));
  adjacentFailures = speciesLists.filter(result => result.failed).length;
  const adjacentStatuses = speciesLists.map(({ pentad, rowIndex, columnIndex, failed }) => ({
    pentad,
    rowIndex,
    columnIndex,
    failed
  }));
  const adjacentSpeciesByRef = new Map();

  speciesLists.forEach(({ pentad, species: adjacentSpecies }) => {
    adjacentSpecies.forEach(adjacentSpeciesItem => {
      if (!adjacentSpeciesItem?.Ref) {
        return;
      }

      if (!adjacentSpeciesByRef.has(adjacentSpeciesItem.Ref)) {
        adjacentSpeciesByRef.set(adjacentSpeciesItem.Ref, {
          Ref: adjacentSpeciesItem.Ref,
          Common_group: adjacentSpeciesItem.Common_group,
          Common_species: adjacentSpeciesItem.Common_species,
          Genus: adjacentSpeciesItem.Genus,
          Species: adjacentSpeciesItem.Species,
          pentadLevels: new Map()
        });
      }

      adjacentSpeciesByRef.get(adjacentSpeciesItem.Ref).pentadLevels.set(
        pentad,
        getReportingLevel(adjacentSpeciesItem)
      );
    });
  });

  species = species.map(speciesItem => {
    const adjacentEntry = adjacentSpeciesByRef.get(speciesItem.Ref);
    const matrix = buildSpeciesGridMatrix(
      getReportingLevel(speciesItem),
      adjacentEntry ? adjacentEntry.pentadLevels : new Map(),
      adjacentStatuses
    );

    return {
      ...speciesItem,
      GridSvg: buildPentadPresenceSvg(matrix)
    };
  });

  const currentPentadRefs = new Set(species.map(speciesItem => speciesItem.Ref));
  const speciesAdjacentArray = Array.from(adjacentSpeciesByRef.values())
    .filter(speciesItem => !currentPentadRefs.has(speciesItem.Ref))
    .map(speciesItem => {
      const pentadCount = Array.from(speciesItem.pentadLevels.values()).filter(level => level > 0).length;
      const matrix = buildSpeciesGridMatrix(
        0,
        speciesItem.pentadLevels,
        adjacentStatuses
      );

      return {
        Ref: speciesItem.Ref,
        Common_group: speciesItem.Common_group,
        Common_species: speciesItem.Common_species,
        Genus: speciesItem.Genus,
        Species: speciesItem.Species,
        Pentads: pentadCount,
        GridSvg: buildPentadPresenceSvg(matrix)
      };
    })
    .filter(speciesItem => speciesItem.Pentads > 0)
    .sort((a, b) => b.Pentads - a.Pentads);
  
  let sortKey = 'fp';
  let sortOrder = 1;
  if (req.query.sortKey) {
    sortKey = req.query.sortKey;
  }
  if (req.query.sortOrder) {
    sortOrder = parseInt(req.query.sortOrder);
  }
  species = species.sort((a,b) => sortOrder * (b[sortKey] - a[sortKey]));
  res.writeHead(200, {
    'Content-Type': 'text/html',
    'X-Pentad-Results-Complete': adjacentFailures === 0 ? 'true' : 'false',
    'X-Pentad-Adjacent-Failures': String(adjacentFailures)
  });
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
              <th>Grid</th>
            </tr>
          </thead>
          <tbody>
            ${species.map(species =>`
              <tr>
                <td>${escapeHtml(species.Common_species || '')}</td>
                <td>${escapeHtml(species.Common_group || '')}</td>
                <td>${parseFloat(species.fp).toFixed(1)}</td>
                <td>${buildListenLink(`${species.Genus} ${species.Species}`, `${species.Common_species} ${species.Common_group || ''}`.trim())}</td>
                ${buildGridCell(species.GridSvg)}
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
              <th>Grid</th>
            </tr>
          </thead>
          <tbody>
            ${speciesAdjacentArray
              .map(species => {
                return `
                  <tr>
                    <td>${escapeHtml(species.Common_group || '')}</td>
                    <td>${escapeHtml(species.Common_species || '')}</td>
                    <td>${species.Pentads}</td>
                    <td>${buildListenLink(`${species.Genus} ${species.Species}`, `${species.Common_species} ${species.Common_group || ''}`.trim())}</td>
                    ${buildGridCell(species.GridSvg)}
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
