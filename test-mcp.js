const https = require('https');

const MCP_URL = 'https://calories-mcp.icynarco112.workers.dev/sse';

async function testMCP() {
  console.log('Connecting to SSE endpoint...');

  return new Promise((resolve, reject) => {
    const url = new URL(MCP_URL);

    const req = https.get({
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        'Accept': 'text/event-stream',
      }
    }, (res) => {
      console.log('Status:', res.statusCode);
      console.log('Headers:', JSON.stringify(res.headers, null, 2));

      let messageEndpoint = null;

      res.on('data', (chunk) => {
        const data = chunk.toString();
        console.log('SSE Event:', data);

        // Parse SSE event
        const lines = data.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const eventData = line.slice(6);
            if (eventData.startsWith('/sse/message')) {
              messageEndpoint = 'https://calories-mcp.icynarco112.workers.dev' + eventData;
              console.log('\nMessage endpoint:', messageEndpoint);

              // Send initialize request
              sendInitialize(messageEndpoint);
            }
          }
        }
      });

      res.on('end', () => {
        console.log('Connection closed');
        resolve();
      });
    });

    req.on('error', (e) => {
      console.error('Error:', e);
      reject(e);
    });

    // Close after 10 seconds
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 10000);
  });
}

function sendInitialize(endpoint) {
  const url = new URL(endpoint);
  const data = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    }
  });

  console.log('\nSending initialize to:', endpoint);

  const req = https.request({
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
      console.log('Initialize response:', res.statusCode);
      console.log('Body:', body);

      // If initialize succeeded, request tools list
      if (res.statusCode === 202) {
        console.log('Initialize accepted! Waiting for response via SSE...');
      }
    });
  });

  req.on('error', (e) => console.error('POST error:', e));
  req.write(data);
  req.end();
}

testMCP().then(() => {
  console.log('\nTest complete');
}).catch(console.error);
