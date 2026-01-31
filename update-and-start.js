const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();
const password = '7512690kirill';

console.log('Connecting to server...');

conn.on('ready', () => {
    console.log('Connected! Updating and starting...\n');

    conn.sftp((err, sftp) => {
        if (err) {
            console.error('SFTP error:', err);
            conn.end();
            return;
        }

        // Upload updated docker-compose.yml
        const localFile = path.join(__dirname, 'docker-compose.yml');
        const remoteFile = '/opt/calories-tracker/docker-compose.yml';

        console.log('Uploading updated docker-compose.yml...');
        sftp.fastPut(localFile, remoteFile, (err) => {
            if (err) {
                console.error('Upload error:', err);
                conn.end();
                return;
            }

            console.log('File uploaded! Starting containers...\n');

            const commands = `
                cd /opt/calories-tracker &&
                docker compose down 2>/dev/null || true &&
                docker compose build --no-cache &&
                docker compose up -d &&
                sleep 10 &&
                echo "=== Container Status ===" &&
                docker compose ps &&
                echo "" &&
                echo "=== MCP Server Logs ===" &&
                docker compose logs mcp-server --tail=15 &&
                echo "" &&
                echo "=== Telegram Bot Logs ===" &&
                docker compose logs telegram-bot --tail=15
            `;

            conn.exec(commands, (err, stream) => {
                if (err) {
                    console.error('Exec error:', err);
                    conn.end();
                    return;
                }

                stream.on('close', (code) => {
                    console.log('\n' + (code === 0 ? '✅ All done!' : '⚠️ Completed with warnings'));
                    conn.end();
                }).on('data', (data) => {
                    process.stdout.write(data.toString());
                }).stderr.on('data', (data) => {
                    process.stdout.write(data.toString());
                });
            });
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
