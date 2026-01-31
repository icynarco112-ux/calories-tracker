const { Client } = require('ssh2');

const conn = new Client();
const password = '7512690kirill';

console.log('Starting Cloudflare Tunnel...\n');

conn.on('ready', () => {
    // Quick tunnel без регистрации - создаёт временный URL
    const commands = `
        cd /opt/calories-tracker &&
        echo "Starting quick tunnel to localhost:8787..." &&
        echo "The URL will appear below (it will be something like https://xxx.trycloudflare.com)" &&
        echo "" &&
        nohup cloudflared tunnel --url http://localhost:8787 > /tmp/tunnel.log 2>&1 &
        sleep 5 &&
        cat /tmp/tunnel.log | grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' | head -1
    `;

    conn.exec(commands, (err, stream) => {
        if (err) {
            console.error('Error:', err);
            conn.end();
            return;
        }

        stream.on('close', () => {
            console.log('\n✅ Tunnel started! Use the URL above as your MCP connector URL');
            console.log('\nAdd /sse to the URL for Claude connector:');
            console.log('Example: https://xxx.trycloudflare.com/sse');
            conn.end();
        }).on('data', (data) => {
            process.stdout.write(data.toString());
        }).stderr.on('data', (data) => {
            process.stdout.write(data.toString());
        });
    });
}).on('error', (err) => {
    console.error('Connection error:', err);
}).connect({
    host: '89.117.48.224',
    port: 22,
    username: 'root',
    password: password
});
