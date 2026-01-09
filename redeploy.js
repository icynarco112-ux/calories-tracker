const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();
const password = '7512690kirill';
const remotePath = '/opt/calories-tracker';

console.log('Connecting to server...');

conn.on('ready', () => {
    console.log('Connected! Uploading updated files...\n');

    conn.sftp((err, sftp) => {
        if (err) {
            console.error('SFTP error:', err);
            conn.end();
            return;
        }

        const filesToUpload = [
            'mcp_server/requirements.txt',
            'mcp_server/main.py',
        ];

        let uploadIndex = 0;

        function uploadNext() {
            if (uploadIndex >= filesToUpload.length) {
                console.log('\nFiles uploaded! Building containers...\n');
                buildContainers();
                return;
            }

            const file = filesToUpload[uploadIndex];
            const localFile = path.join(__dirname, file);
            const remoteFile = `${remotePath}/${file}`;

            sftp.fastPut(localFile, remoteFile, (err) => {
                if (err) {
                    console.error(`Error uploading ${file}:`, err.message);
                } else {
                    console.log(`Uploaded: ${file}`);
                }
                uploadIndex++;
                uploadNext();
            });
        }

        function buildContainers() {
            const commands = `
                cd ${remotePath} &&
                docker compose down 2>/dev/null || true &&
                docker compose build --no-cache &&
                docker compose up -d &&
                sleep 10 &&
                echo "=== Container Status ===" &&
                docker compose ps &&
                echo "" &&
                echo "=== Testing MCP Server ===" &&
                curl -s http://localhost:8787/health || echo "MCP server not responding yet"
            `;

            conn.exec(commands, (err, stream) => {
                if (err) {
                    console.error('Exec error:', err);
                    conn.end();
                    return;
                }

                stream.on('close', (code) => {
                    console.log('\n' + (code === 0 ? '✅ All containers started!' : '⚠️ Completed with warnings'));
                    conn.end();
                }).on('data', (data) => {
                    process.stdout.write(data.toString());
                }).stderr.on('data', (data) => {
                    process.stdout.write(data.toString());
                });
            });
        }

        uploadNext();
    });
}).on('error', (err) => {
    console.error('Connection error:', err);
}).connect({
    host: '89.117.48.224',
    port: 22,
    username: 'root',
    password: password
});
