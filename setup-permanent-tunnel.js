const { Client } = require('ssh2');

const conn = new Client();
const password = '7512690kirill';

console.log('Setting up permanent Cloudflare Tunnel...\n');

conn.on('ready', () => {
    // Шаг 1: Авторизация в Cloudflare
    const commands = `
        echo "=== Step 1: Cloudflare Login ===" &&
        echo "Opening authorization URL..." &&
        cloudflared tunnel login 2>&1 | head -20
    `;

    conn.exec(commands, (err, stream) => {
        if (err) {
            console.error('Error:', err);
            conn.end();
            return;
        }

        let output = '';
        stream.on('close', () => {
            console.log('\n📋 Instructions:');
            console.log('1. Open the URL above in your browser');
            console.log('2. Login to Cloudflare and authorize');
            console.log('3. After authorization, run: node create-tunnel.js');
            conn.end();
        }).on('data', (data) => {
            output += data.toString();
            process.stdout.write(data.toString());
        }).stderr.on('data', (data) => {
            output += data.toString();
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
