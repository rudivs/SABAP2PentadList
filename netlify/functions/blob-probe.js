exports.handler = async function () {
  try {
    const { getStore } = await import('@netlify/blobs');
    const key = `probe-${Date.now()}`;
    const value = JSON.stringify({
      ok: true,
      createdAt: new Date().toISOString()
    });

    const store = getStore({
      name: 'blob-probe',
      consistency: 'strong'
    });

    await store.set(key, value);
    const storedValue = await store.get(key, { consistency: 'strong' });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ok: storedValue === value,
        key: key
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ok: false,
        name: error.name,
        message: error.message
      })
    };
  }
};
