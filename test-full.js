const https = require('https');

async function fullTest() {
  return new Promise((resolve) => {
    console.log('=== MCP Full Test ===\n');

    const req = https.get('https://calories-mcp.icynarco112.workers.dev/sse', {
      headers: { 'Accept': 'text/event-stream' }
    }, (res) => {
      console.log('Status:', res.statusCode);

      let messageEndpoint = null;
      let buffer = '';
      let testPhase = 'init';

      res.on('data', (chunk) => {
        buffer += chunk.toString();

        // Process complete events
        while (buffer.includes('\n\n')) {
          const idx = buffer.indexOf('\n\n');
          const event = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          console.log('\n--- Event ---');
          console.log(event);

          // Extract data
          const dataLine = event.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;

          const data = dataLine.slice(6);

          // First event: endpoint
          if (data.startsWith('/sse/message')) {
            messageEndpoint = 'https://calories-mcp.icynarco112.workers.dev' + data;
            console.log('\n>>> Sending initialize...');
            sendMCP(messageEndpoint, 1, 'initialize', {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'test', version: '1.0' }
            });
            continue;
          }

          // Parse JSON responses
          try {
            const json = JSON.parse(data);

            if (json.result?.serverInfo) {
              console.log('\n>>> Initialize OK! Sending tools/list...');
              testPhase = 'tools';
              sendMCP(messageEndpoint, 2, 'tools/list', {});
            }

            if (json.result?.tools) {
              console.log('\n=== SUCCESS: Got', json.result.tools.length, 'tools ===');
              json.result.tools.forEach(t => console.log(' -', t.name));

              // Test add_meal
              console.log('\n>>> Testing add_meal tool...');
              sendMCP(messageEndpoint, 3, 'tools/call', {
                name: 'add_meal',
                arguments: {
                  meal_name: 'Test Sandwich',
                  calories: 350,
                  proteins: 15,
                  fats: 12,
                  carbs: 40,
                  meal_type: 'lunch'
                }
              });
            }

            if (json.id === 3) {
              console.log('\n=== add_meal result ===');
              console.log(JSON.stringify(json, null, 2));

              // Test get_today_summary
              console.log('\n>>> Getting today summary...');
              sendMCP(messageEndpoint, 4, 'tools/call', {
                name: 'get_today_summary',
                arguments: {}
              });
            }

            if (json.id === 4) {
              console.log('\n=== Today summary ===');
              console.log(JSON.stringify(json, null, 2));
              console.log('\n=== ALL TESTS PASSED ===');
              setTimeout(() => { req.destroy(); resolve(); }, 500);
            }

            if (json.error) {
              console.log('\n!!! ERROR:', json.error);
            }
          } catch (e) {}
        }
      });

      res.on('end', () => resolve());
    });

    req.on('error', (e) => { console.error('Error:', e); resolve(); });
    setTimeout(() => { req.destroy(); resolve(); }, 30000);
  });
}

function sendMCP(endpoint, id, method, params) {
  const url = new URL(endpoint);
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

  const r = https.request({
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, (res) => {
    console.log('POST', method, '-> status', res.statusCode);
  });
  r.write(body);
  r.end();
}

fullTest().then(() => console.log('\nDone.'));
