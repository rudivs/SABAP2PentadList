import express from 'express';
import fetch from 'node-fetch';

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Pentad Code Query</title>
      </head>
      <body>
        <h1>Pentad Code Query</h1>
        <form action="/results" method="GET">
          <label for="pentadCode">Enter pentad code:</label><br>
          <input type="text" id="pentadCode" name="pentadCode"><br>
          <button type="submit">Submit</button>
        </form> 
      </body>
    </html>
  `);
});

app.get('/results', async (req, res) => {
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
  //remove elements from speciesAdjacentPentads that are also in species based on Common_species and Common_group
  speciesAdjacentPentads = speciesAdjacentPentads.filter(speciesAdjacent => {
    return !species.some(species => species.Ref === speciesAdjacent.Ref);
  });
  const speciesAdjacent = speciesAdjacentPentads.reduce((counts, species) => {
    if (!counts[species.Ref]) {
      counts[species.Ref] = {
        Ref: species.Ref,
        Common_group: species.Common_group,
        Common_species: species.Common_species,
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
  res.send(`<html> <head> <title>Pentad ${pentadCode}</title> </head> <body> <h1>Pentad ${pentadCode} Species List</h1> <table> <thead> <tr> <th><a href="/results?pentadCode=${pentadCode}&sortKey=Common_species&sortOrder=${sortKey === 'Common_species' ? sortOrder * -1 : 1}">Species</a></th> <th><a href="/results?pentadCode=${pentadCode}&sortKey=Common_group&sortOrder=${sortKey === 'Common_group' ? sortOrder * -1 : 1}">Group</a></th> <th><a href="/results?pentadCode=${pentadCode}&sortKey=fp&sortOrder=${sortKey === 'fp' ? sortOrder * -1 : 1}">FP Rate</a></th> </tr> </thead> <tbody> ${species.map(species =>`
  <tr>
  <td>${species.Common_species}</td>
  <td>${species.Common_group || ''}</td>
  <td>${parseFloat(species.fp).toFixed(1)}</td>
  </tr>
  `).join('')} </tbody> </table> 
  <h2>Possible Species</h2>
  <table>
    <thead>
      <tr>
        <th>Group</th>
        <th>Species</th>
        <th>Pentads</th>
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
            </tr>
          `;
        }).join('')}
    </tbody>
  </table>
  
  </body> </html> `);
  });
  
  app.listen(port, () => {
  console.log(`Listening on port ${port}`);
  });
