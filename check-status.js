const { Client } = require('ssh2');

const conn = new Client();
const password = '7512690kirill';

console.log('Checking containers status...\n');

conn.on('ready', () => {
    const commands = `
        cd /opt/calories-tracker &&
        echo "=== Container Status ===" &&
        docker compose ps &&
        echo "" &&
        echo "=== Testing MCP Server Health ===" &&
        curl -s http://localhost:8787/health &&
        echo "" &&
        echo "" &&
        echo "=== MCP Server Logs ===" &&
        docker compose logs mcp-server --tail=10 2>&1 &&
        echo "" &&
        echo "=== Telegram Bot Logs ===" &&
        docker compose logs telegram-bot --tail=10 2>&1
    `;

    conn.exec(commands, (err, stream) => {
        if (err) {
            console.error('Error:', err);
            conn.end();
            return;
        }

        stream.on('close', () => {
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
