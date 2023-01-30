console.log('Loading app');
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const serverless = require('serverless-http');
const app = express();
const bodyParser = require('body-parser');
const router = express.Router();

router.get('/results', async (req, res) => {
  console.log('Fetching bird list...');
  const pentadCode = req.query.pentadCode;
  const apiUrl = `http://api.adu.org.za/sabap2/v2/coverage/pentad/${pentadCode}?format=JSON`;
  const response = await fetch(apiUrl);
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
    console.log(`Fetching ${pentad}...`);
    const response = await fetch(apiUrl);
    const data = await response.json();
    return data.data.species;
    }));
  let speciesAdjacentPentads = [].concat(...speciesLists);
  speciesAdjacentPentads = speciesAdjacentPentads.filter(speciesAdjacent => {
    return !species.some(species => species.Ref === speciesAdjacent.Ref);
  });
  const speciesAdjacent = speciesAdjacentPentads.reduce((counts, species) => {
    if (!counts[species.Ref]) {
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
                <td><a href="#" onclick="playCall('${species.Genus} ${species.Species}')">Listen</a></td>
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
                    <td><a href="#" onclick="playCall('${species.Genus} ${species.Species}')">Listen</a></td>
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
    const apiUrl = `https://www.xeno-canto.org/api/2/recordings?query=${speciesName}&q:A`;
    console.log(`Fetching '${apiUrl}'...`)
    const response = await fetch(apiUrl);
    const data = await response.json();
    let recordings = data.recordings;
    if (!recordings.length) {
      res.status(404).send('Not found');
      return;
    }
    let randomIndex = Math.floor(Math.random() * recordings.length);
    let randomFile = recordings[randomIndex].file;
    console.log(randomFile);
    res.redirect(randomFile);
    });

  app.use(bodyParser.json());
  app.use('/.netlify/functions/app', router);  // path must route to lambda
  app.use('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  
  module.exports = app;
  module.exports.handler = serverless(app);;
