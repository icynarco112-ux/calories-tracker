const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();
const password = '7512690kirill';
const remotePath = '/opt/calories-tracker';

console.log('Connecting to production server...');

conn.on('ready', () => {
    console.log('Connected! Deploying calories-tracker...');

    conn.sftp((err, sftp) => {
        if (err) {
            console.error('SFTP error:', err);
            conn.end();
            return;
        }

        const localPath = __dirname;
        const filesToUpload = [
            'docker-compose.yml',
            '.env',
            'mcp_server/Dockerfile',
            'mcp_server/requirements.txt',
            'mcp_server/main.py',
            'mcp_server/tools.py',
            'mcp_server/models.py',
            'mcp_server/database.py',
            'telegram_bot/Dockerfile',
            'telegram_bot/requirements.txt',
            'telegram_bot/bot.py',
            'telegram_bot/reports.py',
            'telegram_bot/profile.py',
        ];

        const dirsToCreate = [
            remotePath,
            `${remotePath}/mcp_server`,
            `${remotePath}/telegram_bot`,
        ];

        let dirIndex = 0;
        let fileIndex = 0;

        function createNextDir() {
            if (dirIndex >= dirsToCreate.length) {
                uploadNextFile();
                return;
            }

            const dir = dirsToCreate[dirIndex];
            console.log(`Creating directory: ${dir}`);
            sftp.mkdir(dir, (err) => {
                // Ignore if directory exists
                dirIndex++;
                createNextDir();
            });
        }

        function uploadNextFile() {
            if (fileIndex >= filesToUpload.length) {
                console.log(`\nUploaded ${fileIndex} files successfully!`);
                startContainers();
                return;
            }

            const file = filesToUpload[fileIndex];
            const localFile = path.join(localPath, file);
            const remoteFile = `${remotePath}/${file}`;

            if (!fs.existsSync(localFile)) {
                console.log(`Skipping ${file} (not found locally)`);
                fileIndex++;
                uploadNextFile();
                return;
            }

            sftp.fastPut(localFile, remoteFile, (err) => {
                if (err) {
                    console.error(`Error uploading ${file}:`, err.message);
                } else {
                    console.log(`Uploaded: ${file}`);
                }
                fileIndex++;
                uploadNextFile();
            });
        }

        function startContainers() {
            console.log('\nStarting Docker containers...');
            const commands = [
                `cd ${remotePath}`,
                'docker compose down 2>/dev/null || true',
                'docker compose build --no-cache',
                'docker compose up -d',
                'docker compose ps'
            ].join(' && ');

            conn.exec(commands, (err, stream) => {
                if (err) {
                    console.error('Exec error:', err);
                    conn.end();
                    return;
                }

                stream.on('close', (code) => {
                    if (code === 0) {
                        console.log('\n✅ Deployment successful!');
                        console.log('\nNext steps:');
                        console.log('1. Setup Cloudflare Tunnel on the server');
                        console.log('2. Add the tunnel URL to Claude Custom Connector');
                        console.log('3. Create a Telegram bot via @BotFather');
                        console.log('4. Update .env with your credentials');
                    } else {
                        console.log('\n⚠️ Deployment completed with warnings');
                    }
                    conn.end();
                }).on('data', (data) => {
                    console.log(data.toString());
                }).stderr.on('data', (data) => {
                    console.log(data.toString());
                });
            });
        }

        createNextDir();
    });
}).on('error', (err) => {
    console.error('Connection error:', err);
}).connect({
    host: '89.117.48.224',
    port: 22,
    username: 'root',
    password: password
});
