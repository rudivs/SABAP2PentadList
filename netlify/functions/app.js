console.log('Loading app');
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const serverless = require('serverless-http');
const app = express();
const bodyParser = require('body-parser');
const router = express.Router();

function fetchCalls(species, quality, country){
  let apiUrl = `https://www.xeno-canto.org/api/2/recordings?query=${species}`;
  if (quality) {
    apiUrl += `%20q:${quality}`;
  }
  if (country) {
    apiUrl += `%20cnt:%22${country}%22`;
  }
  console.log(`Fetching '${apiUrl}'...`)
  return fetch(apiUrl).then(response => response.json());
}

router.get('/results', async (req, res) => {
  console.log('Fetching bird list...');
  const pentadCode = req.query.pentadCode;
  const apiUrl = `http://api.adu.org.za/sabap2/v2/coverage/pentad/${pentadCode}?format=JSON`;
  let response;
  try {
    response = await fetch(apiUrl);
  }
  catch (error) {
    console.error(`Fetching ${pentadCode} failed:`, error);
    res.status(500).send('Fetching bird list failed');
    return;
  }
  const data = await response.json();
  let species = data.data.species;
  const [x, y] = pentadCode.split('_').map(str => parseInt(str));
  const pentads = [
    `${x - 5}_${y - 5}`,
    `${x}_${y - 5}`,
    `${x + 5}_${y - 5}`,
    `${x - 5}_${y}`,
    `${x}_${y}`,
    `${x + 5}_${y}`,
    `${x - 5}_${y + 5}`,
    `${x}_${y + 5}`,
    `${x + 5}_${y + 5}`
    ];
    const speciesLists = await Promise.all(pentads.map(async pentad => { 
      const apiUrl = `http://api.adu.org.za/sabap2/v2/coverage/pentad/${pentad}?format=JSON`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
      try {
        console.log(`Fetching ${pentad} from ${apiUrl}...`);
        const response = await fetch(apiUrl, { signal: controller.signal });
        const data = await response.json();
        if (!data.data.species) {
          console.log(`Pentad ${pentad} returned no species`);
          return [];
        }
        console.log(`Pentad ${pentad} returned ${data.data.species.length} species...`);
        return data.data.species;
      } catch (error) {
        if (error.name === 'AbortError') {
          console.error(`Fetching ${pentad} timed out`);
        } else {
          console.error(`Fetching ${pentad} failed:`, error);
        }
        return [];
      } finally {
        clearTimeout(timeoutId);
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
      <h1>Pentad ${pentadCode} Species List</h1>
      <div style="width:500px">
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
      <h2>Possible Species</h2>
      <div style="width:500px">
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
    // first try to find a call with high quality from South Africa
    let data = await fetchCalls(speciesName, 'A', 'South Africa');
    // if no high quality calls from South Africa, try to find a high quality call from anywhere
    if (!data.recordings.length) {
      data = await fetchCalls(speciesName, 'A', null);
    }
    // if still no calls, it could be a taxonomic issue, try with the common name
    if (!data.recordings.length) {
      data = await fetchCalls(commonName, null, null);
    }
    if (!data.recordings.length) {
      res.status(404).send('Not found');
      return;
    }
    const recordings = data.recordings;
    let randomIndex = Math.floor(Math.random() * recordings.length);
    let result = {};
    result.file = recordings[randomIndex].file;
    result.country = recordings[randomIndex].cnt;
    result.location = recordings[randomIndex].loc;
    result.type = recordings[randomIndex].type;
    console.log(result.file);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(JSON.stringify(result));
    res.end();
    });

  app.use(bodyParser.json());
  app.use('/.netlify/functions/app', router);  // path must route to lambda
  app.use('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  
  module.exports = app;
  module.exports.handler = serverless(app);;
