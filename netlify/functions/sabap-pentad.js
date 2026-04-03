const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const SABAP_PENTAD_CACHE_TTL_SECONDS = 86400;
const SABAP_PENTAD_API_URL = 'http://api.adu.org.za/sabap2/v2/coverage/pentad';

exports.handler = async function (event) {
  const pentadCode = event.queryStringParameters?.code;

  if (!pentadCode || !/^\d{4}_\d{4}$/.test(pentadCode)) {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8'
      },
      body: 'A valid pentad code is required.'
    };
  }

  const apiUrl = `${SABAP_PENTAD_API_URL}/${pentadCode}?format=JSON`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    console.log(`Proxying ${pentadCode} from ${apiUrl}...`);
    const response = await fetch(apiUrl, { signal: controller.signal });

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8'
        },
        body: `SABAP2 request failed with status ${response.status}`
      };
    }

    const body = await response.text();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Netlify-CDN-Cache-Control': `public, durable, max-age=${SABAP_PENTAD_CACHE_TTL_SECONDS}, stale-while-revalidate=${SABAP_PENTAD_CACHE_TTL_SECONDS}`,
        'Netlify-Cache-ID': `sabap2-pentad-${pentadCode}`
      },
      body: body
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      return {
        statusCode: 504,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8'
        },
        body: 'SABAP2 request timed out'
      };
    }

    return {
      statusCode: 502,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8'
      },
      body: 'SABAP2 request failed'
    };
  } finally {
    clearTimeout(timeoutId);
  }
};
