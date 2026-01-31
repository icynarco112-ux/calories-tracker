const https = require('https');

const MCP_URL = 'https://calories-mcp.icynarco112.workers.dev/sse';

async function testTools() {
  console.log('Testing MCP tools/list...\n');

  return new Promise((resolve, reject) => {
    const url = new URL(MCP_URL);

    const req = https.get({
      hostname: url.hostname,
      path: url.pathname,
      headers: { 'Accept': 'text/event-stream' }
    }, (res) => {
      let messageEndpoint = null;
      let messageId = 1;

      res.on('data', (chunk) => {
        const data = chunk.toString();
        const lines = data.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const eventData = line.slice(6);

            if (eventData.startsWith('/sse/message')) {
              messageEndpoint = 'https://calories-mcp.icynarco112.workers.dev' + eventData;
              console.log('Connected! Session endpoint:', messageEndpoint);

              // Send initialize
              sendRequest(messageEndpoint, messageId++, 'initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'test', version: '1.0' }
              });
            } else {
              try {
                const json = JSON.parse(eventData);
                console.log('\nReceived:', JSON.stringify(json, null, 2));

                // After initialize, send tools/list
                if (json.result?.serverInfo && messageEndpoint) {
                  setTimeout(() => {
                    console.log('\nRequesting tools list...');
                    sendRequest(messageEndpoint, messageId++, 'tools/list', {});
                  }, 500);
                }

                // If we got tools, we're done
                if (json.result?.tools) {
                  console.log('\n=== TOOLS AVAILABLE ===');
                  json.result.tools.forEach(t => {
                    console.log(`- ${t.name}: ${t.description}`);
                  });
                  setTimeout(() => {
                    req.destroy();
                    resolve();
                  }, 500);
                }

                // Log any errors
                if (json.error) {
                  console.log('\nERROR:', json.error);
                }
              } catch (e) {}
            }
          }
        }
      });
    });

    req.on('error', reject);
    setTimeout(() => { req.destroy(); resolve(); }, 15000);
  });
}

function sendRequest(endpoint, id, method, params) {
  const url = new URL(endpoint);
  const data = JSON.stringify({ jsonrpc: '2.0', id, method, params });

  const req = https.request({
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  }, (res) => {});
  req.on('error', console.error);
  req.write(data);
  req.end();
}

testTools().then(() => console.log('\nDone!')).catch(console.error);
